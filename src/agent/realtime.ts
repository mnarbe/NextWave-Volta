// -----------------------------------------------------------------------------
// agent/realtime.ts
// Bridge to the OpenAI Realtime API (GA). It is the SAME bridge for both
// transports; the only thing that changes is the audio codec:
//
//   browser -> PCM16 24 kHz     ("audio/pcm")
//   phone   -> G.711 mu-law 8 kHz ("audio/pcmu")  <- exactly what Twilio Media
//              Streams sends and expects, so audio passes straight through in
//              both directions: no resampling, no transcoding.
// -----------------------------------------------------------------------------
import WebSocket from "ws";
import { config } from "../config.js";
import { log, getCall } from "../store/calls.js";
import { buildInstructions, buildIntakeInstructions } from "./prompts.js";
import { toolDefinitions, intakeToolDefinitions, runTool } from "./tools.js";
import { DEFAULT_MANDATE } from "../domain/defaults.js";

// "intake" = Volta talks to the CLIENT to capture the mandate.
// "negotiate" = Volta negotiates with a carrier.
export type Phase = "intake" | "negotiate";

// How the audio reaches the person.
export type Transport = "browser" | "phone";

type Callbacks = {
  // Volta's audio -> transport (browser speakers or Twilio).
  sendAudio: (base64: string) => void;
  // Drop whatever the transport still has queued (barge-in).
  clearAudio: () => void;
  // "Business" events for the dashboard (transcripts, tools, etc.).
  onEvent: (kind: string, data: unknown) => void;
  // Volta finished speaking and asked to close (end_intake / end_negotiation).
  // The transport decides how to hang up: the browser waits a moment, Twilio
  // sends a "mark" and hangs up once the last audio has actually played.
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
  // Is a model response in flight? Only then does response.cancel make sense
  // (the GA API errors out if there is no active response).
  private responseActive = false;
  // Volta already called end_intake / end_negotiation: hang up as soon as it
  // stops talking (not in the middle of the closing line).
  private pendingFinal = false;
  private finalFired = false;

  constructor(callId: string, cb: Callbacks, opts: BridgeOptions = {}) {
    this.callId = callId;
    this.cb = cb;
    this.phase = opts.phase ?? "intake";
    this.transport = opts.transport ?? "browser";

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

  // The audio format we negotiate with OpenAI, per transport.
  private audioFormat() {
    return this.transport === "phone"
      ? { type: "audio/pcmu" } // G.711 mu-law 8 kHz — Twilio's codec.
      : { type: "audio/pcm", rate: 24000 };
  }

  // Over the phone the VAD hears 8 kHz audio with line noise: we lower the
  // threshold a bit so it does not eat turns, and wait slightly less silence
  // because on a phone call long pauses feel endless.
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
          // Higher = less sensitive: ignores room noise and faint voices.
          threshold: 0.7,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
        };
  }

  private onOpen() {
    const call = getCall(this.callId);
    if (!call) return;

    const isIntake = this.phase === "intake";

    // A negotiation with no mandate used to silently fall back to the intake
    // script: Volta would greet the carrier as if calling for a quote and then
    // interrogate them for the brief — origin, destination, container number.
    // Never do that. If the mandate is missing we still negotiate, against the
    // default, and say so loudly in the log.
    if (!isIntake && !call.mandate) {
      log(this.callId, "error", {
        where: "realtime.onOpen",
        msg: "negotiate phase with no mandate — negotiating against defaults",
      });
    }

    const instructions = isIntake
      ? buildIntakeInstructions()
      : buildInstructions(call.mandate ?? DEFAULT_MANDATE);
    const tools = isIntake ? intakeToolDefinitions : toolDefinitions;

    console.log(
      `[realtime] call ${this.callId.slice(0, 8)} | phase=${this.phase} ` +
        `script=${isIntake ? "intake" : "negotiate"} transport=${this.transport}`
    );

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
            format: this.audioFormat(),
            // OpenAI's noise suppression, applied before the VAD. "near_field"
            // = close mic (headset, or a phone handset).
            noise_reduction: { type: "near_field" },
            turn_detection: this.turnDetection(),
            transcription: { model: "gpt-4o-mini-transcribe" },
          },
          output: {
            format: this.audioFormat(),
            voice: "alloy",
            // Volta's speaking rate. 1.0 = normal; we push it a bit so it
            // sounds brisk without tripping over itself. Valid range ~0.25-1.5.
            speed: 1.2,
          },
        },
        tools,
        tool_choice: "auto",
      },
    });

    this.ready = true;

    // Volta opens the conversation.
    //
    // NOTE: do NOT pass response.instructions here. In the Realtime API those
    // REPLACE the session instructions for that response, so the opening line
    // would be generated without the mandate — and the model then invents a
    // shipment ("a load from Monterrey to Queretaro") or asks the carrier for
    // details it is supposed to already have. Both prompts describe their own
    // opening line in step 1, so plain response.create is what we want.
    this.send({ type: "response.create" });
  }

  // Incoming audio from the transport -> OpenAI. It already arrives in the
  // format negotiated above (base64), so this is a passthrough.
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
      // Track response start/end so we know whether we can cancel it.
      case "response.created":
        this.responseActive = true;
        break;

      case "response.done":
        this.responseActive = false;
        // If Volta already asked to close, this was the closing line's audio.
        if (this.pendingFinal) this.fireFinal();
        break;

      // GA API: response.audio.delta -> response.output_audio.delta
      case "response.output_audio.delta":
        if (evt.delta) this.cb.sendAudio(evt.delta);
        break;

      // Barge-in: the person started talking. We always flush the transport's
      // queued audio; we only cancel on the server if a response is in flight
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
        // "response_cancel_not_active": the response ended just before our
        // barge-in response.cancel landed. Harmless: swallow it so the UI does
        // not fill up with red errors.
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
      /* empty args if it does not parse */
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

    // Carrier refused to come down -> event for the UI counter.
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

    // end_intake / end_negotiation: Volta already said its closing line. We do
    // not ask for another response; we flag that we must hang up and let the
    // transport wait until the last audio has finished playing.
    if (evt.name === "end_intake" || evt.name === "end_negotiation") {
      const kind = evt.name === "end_intake" ? "intake_done" : "negotiation_done";
      log(this.callId, kind, result);
      this.cb.onEvent(kind, result);
      this.pendingFinal = true;
      // If the model already stopped talking, close now; otherwise on response.done.
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
