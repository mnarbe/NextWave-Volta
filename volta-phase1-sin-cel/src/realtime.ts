// -----------------------------------------------------------------------------
// realtime.ts
// Puente con la OpenAI Realtime API. Casi idéntico a la versión con teléfono,
// con DOS diferencias:
//   1) Audio en PCM16 24kHz (lo que pide OpenAI) en vez de μ-law 8kHz de Twilio.
//   2) Un callback onEvent() que reenvía transcripts y tool calls al navegador,
//      para que VEAS en vivo cómo el backend recibe y procesa los datos.
// -----------------------------------------------------------------------------
import WebSocket from "ws";
import { config } from "./config.js";
import { log, getCall } from "./store.js";
import { buildInstructions, buildIntakeInstructions } from "./prompt.js";
import { toolDefinitions, intakeToolDefinitions, runTool } from "./tools.js";

// "intake" = Volta habla con el JURADO para capturar el mandato.
// "negotiate" = Volta negocia con un transportista (fase siguiente).
export type Phase = "intake" | "negotiate";

type Callbacks = {
  // Audio (base64 PCM16) de Volta -> navegador para reproducir.
  sendAudio: (base64: string) => void;
  // Pedirle al navegador que corte el audio en curso (barge-in).
  clearAudio: () => void;
  // Eventos "de negocio" para mostrar en la UI (transcripts, tools, etc.).
  onEvent: (kind: string, data: unknown) => void;
};

export class RealtimeBridge {
  private ws: WebSocket;
  private callId: string;
  private cb: Callbacks;
  private phase: Phase;
  private ready = false;
  // ¿Hay una respuesta del modelo en curso? Solo entonces tiene sentido
  // mandar response.cancel (la API GA tira error si no hay ninguna activa).
  private responseActive = false;

  constructor(callId: string, cb: Callbacks, phase: Phase = "intake") {
    this.callId = callId;
    this.cb = cb;
    this.phase = phase;

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
            // <-- diferencia con teléfono: PCM16 24kHz en ambos lados.
            format: { type: "audio/pcm", rate: 24000 },
            // Supresión de ruido de OpenAI antes del VAD. "near_field" = mic
            // cercano (auriculares/headset); usá "far_field" si hablás lejos.
            noise_reduction: { type: "near_field" },
            turn_detection: {
              type: "server_vad",
              // Más alto = menos sensible: ignora ruido de ambiente y voces bajas.
              threshold: 0.7,
              prefix_padding_ms: 300,
              // Espera más silencio antes de dar por terminado tu turno.
              silence_duration_ms: 800,
            },
            transcription: { model: "gpt-4o-mini-transcribe" },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: "alloy",
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
          ? "Greet briefly, introduce yourself as Volta, say you're ready to take " +
            "the job details, and ask the client to walk you through the shipment " +
            "and their maximum price. Then wait for their reply. Speak in English."
          : "Greet briefly, introduce yourself as Volta, and say you're calling to get " +
            "a quote to move a container. Then wait for their reply. Speak in English.",
      },
    });
  }

  // Audio entrante desde el navegador -> OpenAI.
  public appendAudio(base64Pcm16: string) {
    if (!this.ready) return;
    this.send({ type: "input_audio_buffer.append", audio: base64Pcm16 });
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
        break;

      // API GA: response.audio.delta -> response.output_audio.delta
      case "response.output_audio.delta":
        if (evt.delta) this.cb.sendAudio(evt.delta);
        break;

      // Barge-in: la persona empezó a hablar. Siempre limpiamos el audio en
      // cola del navegador; solo cancelamos en el servidor si hay una respuesta
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

    // end_intake / end_negotiation: Volta ya dijo su cierre. Cortamos la llamada
    // dando un margen para que termine de sonar el último audio.
    if (evt.name === "end_intake") {
      log(this.callId, "intake_done", {});
      this.cb.onEvent("intake_done", {});
      setTimeout(() => this.close(), 3500);
      return;
    }
    if (evt.name === "end_negotiation") {
      log(this.callId, "negotiation_done", result);
      this.cb.onEvent("negotiation_done", result);
      setTimeout(() => this.close(), 3500);
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
