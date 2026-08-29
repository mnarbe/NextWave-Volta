// -----------------------------------------------------------------------------
// realtime.ts
// Puente con la OpenAI Realtime API (GA). Es el MISMO puente para los dos
// transportes; lo único que cambia es el códec de audio:
//
//   navegador -> PCM16 24 kHz  ("audio/pcm")
//   teléfono  -> G.711 μ-law 8 kHz ("audio/pcmu")  <- exactamente lo que manda
//                y espera Twilio Media Streams, así que el audio pasa derecho
//                en los dos sentidos, sin remuestrear ni transcodificar.
// -----------------------------------------------------------------------------
import WebSocket from "ws";
import { config } from "../config.js";
import { log, getCall } from "../store.js";
import { buildInstructions, buildIntakeInstructions } from "./prompt.js";
import { toolDefinitions, intakeToolDefinitions, runTool } from "./tools.js";

// "intake" = Volta habla con el JURADO para capturar el mandato.
// "negotiate" = Volta negocia con un transportista.
export type Phase = "intake" | "negotiate";

// Cómo viaja el audio hasta la persona.
export type Transport = "browser" | "phone";

type Callbacks = {
  // Audio de Volta -> transporte (parlantes del navegador o Twilio).
  sendAudio: (base64: string) => void;
  // Cortar el audio ya encolado del lado del transporte (barge-in).
  clearAudio: () => void;
  // Eventos "de negocio" para el dashboard (transcripts, tools, etc.).
  onEvent: (kind: string, data: unknown) => void;
  // Volta terminó de hablar y pidió cerrar (end_intake / end_negotiation).
  // El transporte decide cómo colgar: el navegador espera un ratito, Twilio
  // manda un "mark" y cuelga cuando terminó de reproducirse el último audio.
  onFinal: () => void;
};

export type BridgeOptions = {
  phase?: Phase;
  transport?: Transport;
};

export class RealtimeBridge {
  private ws: WebSocket;
  private callId: string;
  private cb: Callbacks;
  private phase: Phase;
  private transport: Transport;
  private ready = false;
  // ¿Hay una respuesta del modelo en curso? Solo entonces tiene sentido
  // mandar response.cancel (la API GA tira error si no hay ninguna activa).
  private responseActive = false;
  // Volta ya llamó end_intake / end_negotiation: colgamos apenas termine de
  // hablar (no en el medio de la frase de cierre).
  private pendingFinal = false;
  private finalFired = false;

  constructor(callId: string, cb: Callbacks, opts: BridgeOptions = {}) {
    this.callId = callId;
    this.cb = cb;
    this.phase = opts.phase ?? "intake";
    this.transport = opts.transport ?? "browser";

    // API GA: sin el header "OpenAI-Beta". El modelo va en la query y también
    // dentro de session.update (abajo).
    const url = `wss://api.openai.com/v1/realtime?model=${config.openaiRealtimeModel}`;
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
    });

    this.ws.on("open", () => this.onOpen());
    this.ws.on("message", (raw) => this.onMessage(raw));
    this.ws.on("error", (err) =>
      log(this.callId, "error", { where: "openai_ws", err: String(err) })
    );
    this.ws.on("close", () => log(this.callId, "call_ended", { side: "openai" }));
  }

  // El formato de audio que negociamos con OpenAI, según el transporte.
  private audioFormat() {
    return this.transport === "phone"
      ? { type: "audio/pcmu" } // G.711 μ-law 8 kHz — el de Twilio.
      : { type: "audio/pcm", rate: 24000 };
  }

  // El VAD del teléfono escucha audio de 8 kHz con ruido de línea: bajamos un
  // poco el umbral para que no se coma turnos, y esperamos algo menos de
  // silencio porque por teléfono los silencios largos se sienten eternos.
  private turnDetection() {
    return this.transport === "phone"
      ? {
          type: "server_vad",
          threshold: 0.55,
          prefix_padding_ms: 300,
          silence_duration_ms: 700,
        }
      : {
          type: "server_vad",
          // Más alto = menos sensible: ignora ruido de ambiente y voces bajas.
          threshold: 0.7,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
        };
  }

  private onOpen() {
    const call = getCall(this.callId);
    if (!call) return;

    const isIntake = this.phase === "intake";
    const instructions =
      isIntake || !call.mandate
        ? buildIntakeInstructions()
        : buildInstructions(call.mandate);
    const tools = isIntake ? intakeToolDefinitions : toolDefinitions;

    this.send({
      type: "session.update",
      session: {
        // API GA: session.type es obligatorio y el audio va anidado en audio.{input,output}.
        type: "realtime",
        model: config.openaiRealtimeModel,
        instructions,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: this.audioFormat(),
            // Supresión de ruido de OpenAI antes del VAD. "near_field" = mic
            // cercano (auriculares/headset, o el auricular del teléfono).
            noise_reduction: { type: "near_field" },
            turn_detection: this.turnDetection(),
            transcription: { model: "gpt-4o-mini-transcribe" },
          },
          output: {
            format: this.audioFormat(),
            voice: "alloy",
            // Ritmo de habla de Volta. 1.0 = normal; subimos un poco para que
            // hable más rápido sin atropellarse. Rango válido ~0.25-1.5.
            speed: 1.2,
          },
        },
        tools,
        tool_choice: "auto",
      },
    });

    this.ready = true;

    // Volta abre la conversación.
    this.send({
      type: "response.create",
      response: {
        instructions: isIntake
          ? "Greet briefly, introduce yourself as Volta, say you are ready to take " +
            "the job details, and ask the client to walk you through the shipment " +
            "and their maximum price. Then wait for their reply. Speak in English, " +
            "at a brisk, efficient pace."
          : "Greet briefly, introduce yourself as Volta, and say you are calling to get " +
            "a quote to move a container. Then wait for their reply. Speak in English, " +
            "at a brisk, efficient pace.",
      },
    });
  }

  // Audio entrante desde el transporte -> OpenAI. Ya viene en el formato que
  // negociamos arriba (base64), así que es un passthrough.
  public appendAudio(base64Audio: string) {
    if (!this.ready) return;
    this.send({ type: "input_audio_buffer.append", audio: base64Audio });
  }

  private onMessage(raw: WebSocket.RawData) {
    let evt: any;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (evt.type) {
      // Marcamos inicio/fin de respuesta para saber si podemos cancelarla.
      case "response.created":
        this.responseActive = true;
        break;

      case "response.done":
        this.responseActive = false;
        // Si Volta ya pidió cerrar, este era el audio de la frase de cierre.
        if (this.pendingFinal) this.fireFinal();
        break;

      // API GA: response.audio.delta -> response.output_audio.delta
      case "response.output_audio.delta":
        if (evt.delta) this.cb.sendAudio(evt.delta);
        break;

      // Barge-in: la persona empezó a hablar. Siempre limpiamos el audio en
      // cola del transporte; solo cancelamos en el servidor si hay una respuesta
      // en curso (si no, la API GA responde con response_cancel_not_active).
      case "input_audio_buffer.speech_started":
        this.cb.clearAudio();
        if (this.responseActive) {
          log(this.callId, "barge_in", {});
          this.cb.onEvent("barge_in", {});
          this.send({ type: "response.cancel" });
          this.responseActive = false;
        }
        break;

      case "conversation.item.input_audio_transcription.completed":
        log(this.callId, "user_transcript", evt.transcript);
        this.cb.onEvent("user_transcript", evt.transcript);
        break;

      // API GA: response.audio_transcript.done -> response.output_audio_transcript.done
      case "response.output_audio_transcript.done":
        log(this.callId, "agent_transcript", evt.transcript);
        this.cb.onEvent("agent_transcript", evt.transcript);
        break;

      case "response.function_call_arguments.done":
        this.handleFunctionCall(evt);
        break;

      case "error": {
        const err = evt.error || evt;
        // "response_cancel_not_active": el response terminó justo antes de que
        // llegara nuestro response.cancel del barge-in. Es benigno: lo ignoramos
        // para no ensuciar la UI con un error rojo.
        if (err?.code === "response_cancel_not_active") {
          this.responseActive = false;
          break;
        }
        log(this.callId, "error", err);
        this.cb.onEvent("error", err);
        break;
      }
    }
  }

  private fireFinal() {
    if (this.finalFired) return;
    this.finalFired = true;
    this.pendingFinal = false;
    this.cb.onFinal();
  }

  private async handleFunctionCall(evt: any) {
    let args: any = {};
    try {
      args = JSON.parse(evt.arguments || "{}");
    } catch {
      /* args vacío si no parsea */
    }

    // Mostramos en la UI que el modelo pidió una tool y con qué argumentos.
    log(this.callId, "tool_call", { name: evt.name, args });
    this.cb.onEvent("tool_call", { name: evt.name, args });

    const result = await runTool(this.callId, evt.name, args);

    log(this.callId, "tool_result", { name: evt.name, result });
    this.cb.onEvent("tool_result", { name: evt.name, result });

    // Mandato capturado -> evento dedicado para que la UI lo muestre destacado.
    if (evt.name === "set_negotiation_mandate" && (result as any).saved) {
      const mandate = (result as any).mandate;
      log(this.callId, "mandate_captured", mandate);
      this.cb.onEvent("mandate_captured", mandate);
    }

    // Oferta / condición / demora del carrier -> panel de negociación en la UI.
    if (evt.name === "log_carrier_offer" && (result as any).carrier) {
      log(this.callId, "carrier_offer", (result as any).carrier);
      this.cb.onEvent("carrier_offer", (result as any).carrier);
    }

    // Compromiso cerrado -> refrescamos la tarjeta del carrier.
    if (evt.name === "propose_commitment" && (result as any).committed) {
      this.cb.onEvent("carrier_offer", { callId: this.callId });
    }

    // Negativa del carrier a bajar -> evento para el contador en la UI.
    if (evt.name === "note_carrier_refusal") {
      log(this.callId, "carrier_refusal", result);
      this.cb.onEvent("carrier_refusal", result);
    }

    // Devolvemos el resultado al modelo.
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: evt.call_id,
        output: JSON.stringify(result),
      },
    });

    // end_intake / end_negotiation: Volta ya dijo su cierre. No pedimos otra
    // respuesta; marcamos que hay que colgar y dejamos que el transporte espere
    // a que termine de sonar el último audio.
    if (evt.name === "end_intake" || evt.name === "end_negotiation") {
      const kind = evt.name === "end_intake" ? "intake_done" : "negotiation_done";
      log(this.callId, kind, result);
      this.cb.onEvent(kind, result);
      this.pendingFinal = true;
      // Si el modelo ya terminó de hablar, cerramos ahora; si no, en response.done.
      if (!this.responseActive) this.fireFinal();
      return;
    }

    this.send({ type: "response.create" });
  }

  private send(obj: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  public close() {
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}
