// -----------------------------------------------------------------------------
// realtime.ts
// Puente con la OpenAI Realtime API, AGNÓSTICO DEL TRANSPORTE.
//
// El mismo bridge sirve para:
//   - navegador  -> PCM16 24kHz  (audioFormat: "pcm24")
//   - teléfono   -> G.711 μ-law 8kHz (audioFormat: "pcmu")
//
// La API GA acepta "audio/pcmu" directamente, así que con Twilio NO hay que
// transcodificar nada: el base64 de Twilio entra tal cual y la respuesta sale
// tal cual. Lo único que cambia es este campo de config.
// -----------------------------------------------------------------------------
import WebSocket from "ws";
import { config } from "./config.js";
import { log, getCall } from "./store.js";
import { buildInstructions, buildIntakeInstructions } from "./prompt.js";
import { toolDefinitions, intakeToolDefinitions, runTool } from "./tools.js";

// "intake" = Volta captura el mandato del cliente/jurado.
// "negotiate" = Volta negocia con un transportista.
export type Phase = "intake" | "negotiate";

// "pcm24" = PCM16 24kHz (navegador). "pcmu" = G.711 μ-law 8kHz (teléfono).
export type AudioFormat = "pcm24" | "pcmu";

export type Callbacks = {
  // Audio (base64) de Volta -> transporte (parlantes del navegador o llamada).
  sendAudio: (base64: string) => void;
  // Cortar el audio en curso (barge-in).
  clearAudio: () => void;
  // Eventos "de negocio" para la UI / el log.
  onEvent: (kind: string, data: unknown) => void;
  // Cuántos ms del audio del agente se escucharon REALMENTE. Solo el transporte
  // lo sabe (el navegador por su cola; Twilio por media.timestamp). Se usa para
  // truncar el item en OpenAI y que el modelo no crea que dijo lo que se cortó.
  playedMs?: () => number;
  // Primer delta de audio de una respuesta: el transporte marca el t0 de reproducción.
  onResponseStart?: (itemId: string) => void;
};

export type BridgeOptions = {
  callId: string;
  cb: Callbacks;
  phase?: Phase;
  audioFormat?: AudioFormat;
};

// La API GA pide "rate" para PCM y NO lo acepta para μ-law (8kHz implícito).
function formatFor(audioFormat: AudioFormat) {
  return audioFormat === "pcmu"
    ? { type: "audio/pcmu" }
    : { type: "audio/pcm", rate: 24000 };
}

export class RealtimeBridge {
  private ws: WebSocket;
  private callId: string;
  private cb: Callbacks;
  private phase: Phase;
  private audioFormat: AudioFormat;
  private ready = false;
  // ¿Hay una respuesta del modelo en curso? Solo entonces tiene sentido
  // mandar response.cancel (la API GA tira error si no hay ninguna activa).
  private responseActive = false;
  // Item de audio que se está reproduciendo: lo necesitamos para truncarlo.
  private currentItemId: string | null = null;
  private sawFirstDelta = false;

  constructor(opts: BridgeOptions) {
    this.callId = opts.callId;
    this.cb = opts.cb;
    this.phase = opts.phase ?? "intake";
    this.audioFormat = opts.audioFormat ?? "pcm24";

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
    const format = formatFor(this.audioFormat);

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
            format,
            // Supresión de ruido de OpenAI antes del VAD. "near_field" = mic
            // cercano: vale tanto para auriculares como para un teléfono.
            noise_reduction: { type: "near_field" },
            turn_detection: {
              type: "server_vad",
              // El audio telefónico es de banda angosta y más comprimido: con
              // el umbral alto del navegador (0.7) se come turnos enteros.
              threshold: this.audioFormat === "pcmu" ? 0.5 : 0.7,
              prefix_padding_ms: 300,
              silence_duration_ms: this.audioFormat === "pcmu" ? 700 : 800,
            },
            transcription: { model: "gpt-4o-mini-transcribe" },
          },
          output: {
            format,
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

  // Audio entrante desde el transporte -> OpenAI.
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
        this.sawFirstDelta = false;
        break;

      case "response.done":
        this.responseActive = false;
        this.currentItemId = null;
        break;

      // API GA: response.audio.delta -> response.output_audio.delta
      case "response.output_audio.delta":
        if (!evt.delta) break;
        this.currentItemId = evt.item_id ?? this.currentItemId;
        if (!this.sawFirstDelta) {
          this.sawFirstDelta = true;
          if (this.currentItemId) this.cb.onResponseStart?.(this.currentItemId);
        }
        this.cb.sendAudio(evt.delta);
        break;

      // Barge-in: la persona empezó a hablar.
      //   1) el transporte tira lo que tenga en cola,
      //   2) truncamos el item en OpenAI hasta lo que REALMENTE se escuchó
      //      (si no, el modelo cree que dijo el final que nadie oyó),
      //   3) cancelamos la respuesta en curso.
      case "input_audio_buffer.speech_started": {
        this.cb.clearAudio();
        if (!this.responseActive) break;

        const played = Math.max(0, Math.round(this.cb.playedMs?.() ?? 0));
        log(this.callId, "barge_in", { playedMs: played, itemId: this.currentItemId });
        this.cb.onEvent("barge_in", { playedMs: played });

        if (this.currentItemId && played > 0) {
          this.send({
            type: "conversation.item.truncate",
            item_id: this.currentItemId,
            content_index: 0,
            audio_end_ms: played,
          });
        }
        this.send({ type: "response.cancel" });
        this.responseActive = false;
        this.currentItemId = null;
        break;
      }

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
        // Benignos: el response terminó justo antes de que llegara nuestro
        // cancel/truncate del barge-in. No los mostramos como error rojo.
        if (
          err?.code === "response_cancel_not_active" ||
          err?.code === "item_truncate_invalid_audio_end_ms"
        ) {
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

    // El transportista se negó: la UI lleva la cuenta de negativas.
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
