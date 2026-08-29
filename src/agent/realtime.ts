// -----------------------------------------------------------------------------
// agent/realtime.ts
// Bridge to the OpenAI Realtime API. Almost identical to the phone version, with
// TWO differences:
//   1) PCM16 24kHz audio (what OpenAI wants) instead of Twilio's 8kHz mu-law.
//   2) An onEvent() callback that forwards transcripts and tool calls to the
//      browser, so you can SEE live how the backend receives and processes data.
// -----------------------------------------------------------------------------
import WebSocket from "ws";
import { config } from "../config.js";
import { log, getCall } from "../store/calls.js";
import { buildInstructions, buildIntakeInstructions } from "./prompts.js";
import { toolDefinitions, intakeToolDefinitions, runTool } from "./tools.js";

// "intake" = Volta talks to the CLIENT to capture the mandate.
// "negotiate" = Volta negotiates with a carrier (next phase).
export type Phase = "intake" | "negotiate";

type Callbacks = {
  // Volta's audio (base64 PCM16) -> browser, for playback.
  sendAudio: (base64: string) => void;
  // Ask the browser to cut the audio currently playing (barge-in).
  clearAudio: () => void;
  // "Business" events to show in the UI (transcripts, tools, etc.).
  onEvent: (kind: string, data: unknown) => void;
};

export class RealtimeBridge {
  private ws: WebSocket;
  private callId: string;
  private cb: Callbacks;
  private phase: Phase;
  private ready = false;
  // Is a model response in flight? Only then does response.cancel make sense
  // (the GA API errors out if there is no active response).
  private responseActive = false;

  constructor(callId: string, cb: Callbacks, phase: Phase = "intake") {
    this.callId = callId;
    this.cb = cb;
    this.phase = phase;

    // GA API: no "OpenAI-Beta" header. The model goes in the query string and
    // also inside session.update (below).
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
        // GA API: session.type is required and audio nests under audio.{input,output}.
        type: "realtime",
        model: config.openaiRealtimeModel,
        instructions,
        output_modalities: ["audio"],
        audio: {
          input: {
            // <-- difference vs phone: PCM16 24kHz on both sides.
            format: { type: "audio/pcm", rate: 24000 },
            // OpenAI noise suppression before the VAD. "near_field" = close mic
            // (headset); use "far_field" if you speak far from the mic.
            noise_reduction: { type: "near_field" },
            turn_detection: {
              type: "server_vad",
              // Higher = less sensitive: ignores room noise and low voices.
              threshold: 0.7,
              prefix_padding_ms: 300,
              // Waits for more silence before considering your turn over.
              silence_duration_ms: 800,
            },
            transcription: { model: "gpt-4o-mini-transcribe" },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: "alloy",
            // Volta's speaking rate. 1.0 = normal; we push it up a little so it
            // talks faster without tripping over itself. Valid range ~0.25-1.5.
            speed: 1.2,
          },
        },
        tools,
        tool_choice: "auto",
      },
    });

    this.ready = true;

    // Volta opens the conversation.
    this.send({
      type: "response.create",
      response: {
        instructions: isIntake
          ? "Greet briefly, introduce yourself as Volta, say you're ready to take " +
            "the job details, and ask the client to walk you through the shipment " +
            "and their maximum price. Then wait for their reply. Speak in English, " +
            "at a brisk, efficient pace."
          : "Greet briefly, introduce yourself as Volta, and say you're calling to get " +
            "a quote to move a container. Then wait for their reply. Speak in English, " +
            "at a brisk, efficient pace.",
      },
    });
  }

  // Incoming audio from the browser -> OpenAI.
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
      // Track response start/end so we know whether we can cancel it.
      case "response.created":
        this.responseActive = true;
        break;

      case "response.done":
        this.responseActive = false;
        break;

      // GA API: response.audio.delta -> response.output_audio.delta
      case "response.output_audio.delta":
        if (evt.delta) this.cb.sendAudio(evt.delta);
        break;

      // Barge-in: the person started talking. We always flush the browser's
      // queued audio; we only cancel server-side if a response is in flight
      // (otherwise the GA API replies with response_cancel_not_active).
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

      // GA API: response.audio_transcript.done -> response.output_audio_transcript.done
      case "response.output_audio_transcript.done":
        log(this.callId, "agent_transcript", evt.transcript);
        this.cb.onEvent("agent_transcript", evt.transcript);
        break;

      case "response.function_call_arguments.done":
        this.handleFunctionCall(evt);
        break;

      case "error": {
        const err = evt.error || evt;
        // "response_cancel_not_active": the response finished just before our
        // barge-in response.cancel arrived. Benign: we swallow it so the UI
        // doesn't show a red error.
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
      /* empty args if it doesn't parse */
    }

    // Show in the UI that the model asked for a tool, and with what arguments.
    log(this.callId, "tool_call", { name: evt.name, args });
    this.cb.onEvent("tool_call", { name: evt.name, args });

    const result = await runTool(this.callId, evt.name, args);

    log(this.callId, "tool_result", { name: evt.name, result });
    this.cb.onEvent("tool_result", { name: evt.name, result });

    // Mandate captured -> dedicated event so the UI can highlight it.
    if (evt.name === "set_negotiation_mandate" && (result as any).saved) {
      const mandate = (result as any).mandate;
      log(this.callId, "mandate_captured", mandate);
      this.cb.onEvent("mandate_captured", mandate);
    }

    // Carrier offer / condition / delay -> negotiation panel in the UI.
    if (evt.name === "log_carrier_offer" && (result as any).carrier) {
      log(this.callId, "carrier_offer", (result as any).carrier);
      this.cb.onEvent("carrier_offer", (result as any).carrier);
    }

    // Commitment closed -> refresh the carrier card.
    if (evt.name === "propose_commitment" && (result as any).committed) {
      this.cb.onEvent("carrier_offer", { callId: this.callId });
    }

    // Carrier refusal to come down -> event for the UI counter.
    if (evt.name === "note_carrier_refusal") {
      log(this.callId, "carrier_refusal", result);
      this.cb.onEvent("carrier_refusal", result);
    }

    // Hand the result back to the model.
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: evt.call_id,
        output: JSON.stringify(result),
      },
    });

    // end_intake / end_negotiation: Volta already said its closing line. We hang
    // up after a margin so the last audio finishes playing.
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
