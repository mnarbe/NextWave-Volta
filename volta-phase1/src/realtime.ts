// -----------------------------------------------------------------------------
// realtime.ts
// El puente con la OpenAI Realtime API. Maneja UNA sesión de voz (una llamada).
//
// Flujo de audio:
//   Twilio  --(μ-law 8kHz base64)-->  este bridge  -->  OpenAI Realtime
//   OpenAI  --(μ-law 8kHz base64)-->  este bridge  -->  Twilio
// Usamos g711_ulaw en ambos lados, que es justo lo que manda Twilio: así NO hay
// que transcodificar audio. Ese es el truco que simplifica todo.
//
// Además maneja:
//   - Configuración de la sesión (instrucciones + tools + detección de turnos).
//   - Tool calling: cuando el modelo pide una función, la ejecutamos y le
//     devolvemos el resultado.
//   - Barge-in: si la persona empieza a hablar mientras Volta habla, cortamos
//     el audio en curso.
// -----------------------------------------------------------------------------
import WebSocket from "ws";
import { config } from "./config.js";
import { log, getCall } from "./store.js";
import { buildInstructions } from "./prompt.js";
import { toolDefinitions, runTool } from "./tools.js";

// Callbacks que el bridge usa para hablar con el lado de Twilio.
type Callbacks = {
  // Enviar audio (base64 μ-law) de vuelta a Twilio para que lo reproduzca.
  sendAudio: (base64: string) => void;
  // Pedirle a Twilio que descarte el audio ya encolado (para el barge-in).
  clearAudio: () => void;
};

export class RealtimeBridge {
  private ws: WebSocket;
  private callId: string;
  private cb: Callbacks;
  private ready = false;

  constructor(callId: string, cb: Callbacks) {
    this.callId = callId;
    this.cb = cb;

    // Conexión WebSocket a la Realtime API.
    const url = `wss://api.openai.com/v1/realtime?model=${config.openaiRealtimeModel}`;
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    this.ws.on("open", () => this.onOpen());
    this.ws.on("message", (raw) => this.onMessage(raw));
    this.ws.on("error", (err) => log(this.callId, "error", { where: "openai_ws", err: String(err) }));
    this.ws.on("close", () => log(this.callId, "call_ended", { side: "openai" }));
  }

  // --- Configuración inicial de la sesión ------------------------------------
  private onOpen() {
    const call = getCall(this.callId);
    if (!call) return;

    // session.update: le decimos al modelo cómo comportarse y qué puede hacer.
    this.send({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions: buildInstructions(call.mandate),
        voice: "alloy", // ajustar a la voz que prefieras
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        // Transcripción de lo que dice la persona (para el log/auditoría).
        input_audio_transcription: { model: "whisper-1" },
        // Detección de turnos por VAD del servidor: habilita el barge-in.
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
        tools: toolDefinitions,
        tool_choice: "auto",
        temperature: 0.7,
      },
    });

    this.ready = true;

    // Como es una llamada SALIENTE, dejamos que Volta abra la conversación.
    // Pedimos una primera respuesta (saludo) sin esperar a que hablen.
    this.send({
      type: "response.create",
      response: {
        instructions:
          "Saluda breve, preséntate como Volta y di que llamas para cotizar el " +
          "traslado de un contenedor. Luego espera la respuesta.",
      },
    });
  }

  // --- Audio entrante desde Twilio -> OpenAI ---------------------------------
  public appendAudio(base64Ulaw: string) {
    if (!this.ready) return;
    this.send({ type: "input_audio_buffer.append", audio: base64Ulaw });
  }

  // --- Eventos que llegan desde OpenAI ---------------------------------------
  private onMessage(raw: WebSocket.RawData) {
    let evt: any;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (evt.type) {
      // Fragmento de audio de Volta -> se lo pasamos a Twilio.
      case "response.audio.delta":
        if (evt.delta) this.cb.sendAudio(evt.delta);
        break;

      // La persona empezó a hablar mientras Volta hablaba => BARGE-IN.
      // Cortamos: descartamos el audio encolado en Twilio y cancelamos la
      // respuesta en curso del modelo.
      case "input_audio_buffer.speech_started":
        log(this.callId, "barge_in", {});
        this.cb.clearAudio();
        this.send({ type: "response.cancel" });
        break;

      // Transcripción de lo que dijo la persona (para auditoría).
      case "conversation.item.input_audio_transcription.completed":
        log(this.callId, "user_transcript", evt.transcript);
        break;

      // Transcripción de lo que dijo Volta.
      case "response.audio_transcript.done":
        log(this.callId, "agent_transcript", evt.transcript);
        break;

      // El modelo terminó de decidir los argumentos de una función => ejecutar.
      case "response.function_call_arguments.done":
        this.handleFunctionCall(evt);
        break;

      case "error":
        log(this.callId, "error", evt.error || evt);
        break;
    }
  }

  // --- Tool calling ----------------------------------------------------------
  private async handleFunctionCall(evt: any) {
    // evt trae: name, call_id, arguments (string JSON).
    let args: any = {};
    try {
      args = JSON.parse(evt.arguments || "{}");
    } catch {
      /* dejamos args vacío si no parsea */
    }

    // Ejecutamos la tool contra nuestro backend (mandato, store, etc.).
    const result = await runTool(this.callId, evt.name, args);

    // Le devolvemos el resultado al modelo como "function_call_output".
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: evt.call_id,
        output: JSON.stringify(result),
      },
    });

    // Y le pedimos que continúe la conversación considerando ese resultado.
    this.send({ type: "response.create" });
  }

  // --- util ------------------------------------------------------------------
  private send(obj: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  public close() {
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}
