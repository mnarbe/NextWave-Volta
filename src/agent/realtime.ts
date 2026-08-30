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
import {
  buildInstructions,
  buildIntakeInstructions,
  buildEscalationInstructions,
} from "./prompts.js";
import {
  toolDefinitions,
  intakeToolDefinitions,
  escalationToolDefinitions,
  runTool,
} from "./tools.js";
import { DEFAULT_MANDATE } from "../domain/defaults.js";
import { getNegotiation, lastQuoteFor } from "../store/negotiations.js";
import { currentBooking, isBookedCarrier, pendingChange } from "../negotiation/escalation.js";
import { findCarrierById } from "../negotiation/roster.js";
import { redactWhileUnverified, forgetCall } from "../security/pin.js";

// "intake" = Volta talks to the CLIENT to capture the mandate.
// "negotiate" = Volta negotiates with a carrier.
export type Phase = "intake" | "negotiate" | "escalate";

// How the audio reaches the person.
export type Transport = "browser" | "phone";

// WHY this call is happening. The script follows from this, not from whether a
// booking happens to exist: once one did, every later contact was running the
// "something has gone wrong" script, including the call that books the load.
//   quote           - shopping the load, no commitment yet
//   confirm         - they won: read the terms back and book it
//   change_approved - the client said yes to their change; confirm the new terms
//   change_rejected - the client said no; cancel, politely
//   inbound         - THEY rang US and we do not know why yet
export type CallIntent =
  | "quote"
  | "confirm"
  | "change_approved"
  | "change_rejected"
  | "inbound";

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
  // Why we are on this call. Drives which script Volta runs.
  intent?: CallIntent;
};

export class RealtimeBridge {
  private ws: WebSocket;
  private callId: string;
  private cb: Callbacks;
  private phase: Phase;
  private transport: Transport;
  private intent: CallIntent;
  private ready = false;
  // Is a model response in flight? Only then does response.cancel make sense
  // (the GA API errors out if there is no active response).
  private responseActive = false;
  // Volta already called end_intake / end_negotiation: hang up as soon as it
  // stops talking (not in the middle of the closing line).
  private pendingFinal = false;
  // Did the model actually SAY anything in the response now in flight? If it
  // calls end_* without having spoken, hanging up would cut the call dead —
  // so we ask it for one last line first.
  private spokeThisResponse = false;
  private closingLineRequested = false;
  private finalFired = false;

  constructor(callId: string, cb: Callbacks, opts: BridgeOptions = {}) {
    this.callId = callId;
    this.cb = cb;
    this.phase = opts.phase ?? "intake";
    this.transport = opts.transport ?? "browser";
    this.intent = opts.intent ?? "inbound";

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
    const isEscalation = this.phase === "escalate";

    // Calling the client about a change we are not authorised to accept. The
    // whole call is defined by the pending change; without one there is nothing
    // to ask them, so we fall back to the negotiation script rather than ring
    // someone up with no question.
    const change = isEscalation ? pendingChange() : null;
    if (isEscalation && change && call.mandate) {
      const instructions = buildEscalationInstructions(call.mandate, {
        carrierName: change.carrierName,
        agreed: change.agreed,
        requested: change.requested,
        reasons: change.reasons,
      });
      console.log(
        `[realtime] call ${this.callId.slice(0, 8)} | phase=escalate ` +
          `carrier=${change.carrierName} transport=${this.transport}`
      );
      this.openSession(instructions, escalationToolDefinitions);
      return;
    }
    if (isEscalation) {
      log(this.callId, "error", {
        where: "realtime.onOpen",
        msg: "escalate phase with no pending change — nothing to ask the client",
      });
    }


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

    // If this call is part of a round we already know which carrier is on the
    // line, and Volta must collect a quote rather than book the load: the
    // winner is picked afterwards and called back to confirm.
    const neg = isIntake ? undefined : getNegotiation(this.callId);

    // If we recognised this carrier and they have quoted before, hand Volta
    // that quote so it can open with it instead of starting from scratch.
    const previous =
      neg?.carrierId && !neg.roundId ? lastQuoteFor(neg.carrierId, this.callId) : undefined;

    // Do we already hold a deal WITH THIS CARRIER? Then the numbers are settled
    // and the call is about a change, not a negotiation. Volta must state the
    // agreed figures rather than quoting new ones — without this it happily
    // offered a booked carrier a lower price than the one they had shaken on.
    const booking =
      neg && isBookedCarrier(neg.carrierId, this.callId) ? currentBooking() : null;

    const instructions = isIntake
      ? buildIntakeInstructions()
      : buildInstructions(call.mandate ?? DEFAULT_MANDATE, {
          carrierName: neg?.carrierName || booking?.carrierName || undefined,
          carrierEmail: findCarrierById(neg?.carrierId)?.email,
          intent: this.intent,
          collectingQuotes: Boolean(neg?.roundId) && this.intent === "quote",
          standingOffer: previous,
          booking: booking
            ? {
                priceMxn: booking.priceMxn,
                pickupTime: booking.pickupTime,
                conditions: booking.conditions,
              }
            : undefined,
        });
    const tools = isIntake ? intakeToolDefinitions : toolDefinitions;

    console.log(
      `[realtime] call ${this.callId.slice(0, 8)} | phase=${this.phase} ` +
        `script=${isIntake ? "intake" : booking ? "booked-carrier" : "negotiate"} ` +
        `transport=${this.transport}`
    );

    this.openSession(instructions, tools);
  }

  // Send session.update with the chosen script + tools, then let Volta open the
  // conversation. Shared by every phase.
  private openSession(instructions: string, tools: unknown) {
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
        this.spokeThisResponse = false;
        break;

      case "response.done": {
        const spoke = this.spokeThisResponse;
        this.responseActive = false;
        if (!this.pendingFinal) break;

        // Volta asked to close. If it did so without saying anything on this
        // turn, hanging up now would drop the line mid-conversation — the
        // "Volta cut me off" complaint. Give it exactly one turn to say
        // goodbye, then hang up whatever it does.
        if (!spoke && !this.closingLineRequested) {
          this.closingLineRequested = true;
          log(this.callId, "tool_result", {
            name: "closing",
            note: "end_* called with nothing spoken — asking for a goodbye first",
          });
          this.send({
            type: "response.create",
            response: {
              // Deliberately narrow. These instructions REPLACE the session
              // ones for this response, so the model has no brief in front of
              // it — which is fine for a goodbye, and exactly why it must not
              // reach for any figure here.
              instructions:
                "Close the call now. Say a brief, warm goodbye in one or two " +
                "sentences: thank them by name if you know it and say what " +
                "happens next, in the words you already used. Do NOT introduce " +
                "a new topic, do NOT state any price, date or number, and do " +
                "NOT call any tool.",
            },
          });
          break;
        }

        this.fireFinal();
        break;
      }

      // GA API: response.audio.delta -> response.output_audio.delta
      case "response.output_audio.delta":
        if (evt.delta) {
          this.spokeThisResponse = true;
          this.cb.sendAudio(evt.delta);
        }
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

      case "conversation.item.input_audio_transcription.completed": {
        // Until the caller is verified, whatever they say is very likely their
        // security code — mask digits so it does not land in the transcript,
        // the dashboard or the call log.
        const said = redactWhileUnverified(this.callId, evt.transcript);
        log(this.callId, "user_transcript", said);
        this.cb.onEvent("user_transcript", said);
        break;
      }

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

    // A booked carrier asked for something. If it fits the mandate Volta just
    // accepted it; if not, the transport has to ring the client after this call.
    if (evt.name === "request_change") {
      const kind = (result as any).withinMandate
        ? "change_auto_accepted"
        : "change_needs_provider";
      log(this.callId, kind, result);
      this.cb.onEvent(kind, result);
    }

    // A person is taking over. The dashboard needs to show it, and the
    // transport must not chain another automatic call after this one.
    if (evt.name === "request_human_handoff") {
      log(this.callId, "handed_to_human", result);
      this.cb.onEvent("handed_to_human", result);
    }

    // The client answered: the transport rings the carrier back with the verdict.
    if (evt.name === "record_provider_decision" && (result as any).ok) {
      log(this.callId, "provider_decided", result);
      this.cb.onEvent("provider_decided", result);
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
    if (
      evt.name === "end_intake" ||
      evt.name === "end_negotiation" ||
      evt.name === "end_escalation"
    ) {
      const kind =
        evt.name === "end_intake"
          ? "intake_done"
          : evt.name === "end_escalation"
            ? "escalation_done"
            : "negotiation_done";
      log(this.callId, kind, result);
      this.cb.onEvent(kind, result);
      this.pendingFinal = true;
      // If a response is still in flight, response.done decides: it hangs up if
      // Volta spoke, and asks for a goodbye first if it did not. With nothing in
      // flight there is no audio coming, so ask for the goodbye here.
      if (!this.responseActive && !this.closingLineRequested) {
        this.closingLineRequested = true;
        this.send({
          type: "response.create",
          response: {
            instructions:
              "Close the call now. Say a brief, warm goodbye in one or two " +
              "sentences: thank them by name if you know it and say what happens " +
              "next, in the words you already used. Do NOT introduce a new topic, " +
              "do NOT state any price, date or number, and do NOT call any tool.",
          },
        });
      } else if (!this.responseActive) {
        this.fireFinal();
      }
      return;
    }

    this.send({ type: "response.create" });
  }

  private send(obj: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  public close() {
    // A verified call is verified only while it lasts.
    forgetCall(this.callId);
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}
