// -----------------------------------------------------------------------------
// telephony/stream.ts
// The "phone" transport: WebSocket /twilio/media <-> OpenAI Realtime.
//
// Twilio Media Streams protocol (bidirectional, <Connect><Stream>):
//   Twilio -> us: {event:"connected"} , {event:"start", start:{streamSid,
//                 callSid, ...}} , {event:"media", media:{payload}} ,
//                 {event:"mark", mark:{name}} , {event:"stop"}
//   us -> Twilio: {event:"media", streamSid, media:{payload}}
//                 {event:"clear", streamSid}   (drop what is queued)
//                 {event:"mark",  streamSid, mark:{name}}  (marker Twilio hands
//                 back once it has finished playing everything sent before it)
//
// The payload is base64 G.711 mu-law 8 kHz — the SAME format we ask OpenAI for
// (audio/pcmu), so it travels in both directions untouched.
// -----------------------------------------------------------------------------
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";

import { log } from "../store/calls.js";
import { publish } from "../bus.js";
import { startSession } from "../session.js";
import { forgetCarrier } from "./routing.js";
import { scheduleCarrierCallback } from "./handoff.js";
import type { Phase } from "../agent/realtime.js";

// Marker name we use to hang up only once Volta's closing line has played.
const FINAL_MARK = "volta-final";
// If Twilio never hands the mark back (dropped call, network), hang up anyway.
const FINAL_TIMEOUT_MS = 20_000;

export function handleTwilioMedia(ws: WebSocket, req: IncomingMessage) {
  // Query string values, used as a fallback. Twilio does not reliably carry the
  // query string of the <Stream url> through, so the authoritative source is
  // start.customParameters (read in the "start" event below).
  const query = new URL(req.url || "/", "http://localhost").searchParams;

  let mode: Phase = query.get("mode") === "negotiate" ? "negotiate" : "intake";
  let carrierHint = query.get("carrier") || undefined;
  // The other party's number: who called us, or who we called.
  let peer = query.get("peer") || "";

  let streamSid = "";
  let callSid = "";
  let session: ReturnType<typeof startSession> | null = null;
  let finalTimer: NodeJS.Timeout | null = null;
  let closing = false;
  // Is this intake worth handing off to a negotiation? True as soon as the
  // brief is captured — we do NOT require Volta to reach end_intake, because
  // the provider often hangs up the moment they have finished dictating, and
  // we still want to ring them back as the carrier.
  let briefCaptured = false;

  const toTwilio = (obj: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  const shutdown = () => {
    if (closing) return;
    closing = true;
    if (finalTimer) clearTimeout(finalTimer);
    session?.bridge.close();
    // Closing the WebSocket ends the <Connect><Stream>; with no further TwiML,
    // Twilio hangs up the call.
    try {
      ws.close();
    } catch {
      /* noop */
    }
    if (session) {
      publish({
        kind: "phone_call_ended",
        callId: session.callId,
        transport: "phone",
        data: { callSid },
      });

      // The intake is done and the line is free: hand off to the negotiation by
      // calling the same person back, this time as the carrier.
      console.log(
        `[stream] call ended | mode=${mode} peer=${peer || "(none)"} ` +
          `brief=${briefCaptured ? "captured" : "not captured"}`
      );
      if (mode === "intake" && briefCaptured) {
        scheduleCarrierCallback({ to: peer, fromCallId: session.callId });
      }
    }
  };

  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      // Twilio opened the socket; no audio and no streamSid yet.
      case "connected":
        break;

      // The stream started: now we have streamSid/callSid and can bring up the
      // bridge to OpenAI.
      case "start": {
        streamSid = msg.start?.streamSid || msg.streamSid || "";
        callSid = msg.start?.callSid || "";

        // The <Parameter> values from the TwiML. These win over the query
        // string: they are what Twilio actually guarantees to deliver.
        const params = msg.start?.customParameters || {};
        if (params.mode) mode = params.mode === "negotiate" ? "negotiate" : "intake";
        if (params.peer) peer = String(params.peer);
        if (params.carrier) carrierHint = String(params.carrier);

        console.log(
          `[stream] start | mode=${mode} peer=${peer || "(none)"} ` +
            `source=${params.mode ? "customParameters" : "query"}`
        );

        session = startSession({
          mode,
          transport: "phone",
          // Volta's audio -> Twilio -> the person's handset.
          sendAudio: (payload) =>
            toTwilio({ event: "media", streamSid, media: { payload } }),
          // Barge-in: drop whatever Twilio has queued but not yet played.
          clearAudio: () => toTwilio({ event: "clear", streamSid }),
          // Volta said its closing line: send a mark and hang up when it comes
          // back (i.e. when the audio has actually finished playing).
          onFinal: () => {
            toTwilio({ event: "mark", streamSid, mark: { name: FINAL_MARK } });
            finalTimer = setTimeout(shutdown, FINAL_TIMEOUT_MS);
          },
          // The brief landing is what earns the callback (see shutdown).
          onEvent: (kind) => {
            if (mode === "intake" && (kind === "mandate_captured" || kind === "intake_done")) {
              briefCaptured = true;
            }
          },
        });

        // They picked up as the carrier, so stop expecting them as one.
        if (mode === "negotiate") forgetCarrier(peer);

        log(session.callId, "call_started", {
          transport: "phone",
          mode,
          callSid,
          peer: peer || null,
        });
        publish({
          kind: "phone_call_started",
          callId: session.callId,
          transport: "phone",
          data: { callSid, mode, carrier: carrierHint },
        });
        break;
      }

      // The person's audio -> OpenAI. Passthrough: already base64 mu-law 8 kHz.
      case "media":
        if (msg.media?.payload) session?.bridge.appendAudio(msg.media.payload);
        break;

      // Twilio hands the marker back once it has played everything queued
      // before it. That is the moment to hang up.
      case "mark":
        if (msg.mark?.name === FINAL_MARK) shutdown();
        break;

      // The call ended (they hung up, or we did).
      case "stop":
        shutdown();
        break;
    }
  });

  ws.on("close", () => shutdown());
  ws.on("error", () => shutdown());
}
