// -----------------------------------------------------------------------------
// telephony/handoff.ts
// What happens AFTER a call ends.
//
// Today there is one handoff: when the intake with the provider finishes, Volta
// waits a moment and calls that same number back to negotiate — the person
// plays the carrier on the second call. That is what lets a single phone (and a
// single Twilio number) demo the whole loop.
//
// Any future "and then call X" rule belongs here, not inside the media stream.
// -----------------------------------------------------------------------------
import { config, twilioReady } from "../config.js";
import { publish } from "../bus.js";
import { placeCall } from "./twilio.js";
import { expectCarrier } from "./routing.js";

// How long to wait after hanging up before dialling back. Long enough for
// Twilio to tear the first call down, short enough to feel immediate on stage.
const HANDOFF_DELAY_MS = 3000;

export type HandoffOptions = {
  // Number to call back (E.164). The provider's number in today's flow.
  to: string;
  // The call we are handing off FROM, for the dashboard timeline.
  fromCallId: string;
};

// Returns why we did not schedule anything, or null if it is on its way.
function blockedReason(to: string): string | null {
  if (!twilioReady()) return "twilio_not_configured";
  if (!to) return "no_caller_id";
  // Caller ID withheld shows up as a non-dialable value.
  if (!/^\+[1-9]\d{6,15}$/.test(to)) return "caller_id_not_dialable";
  if (to === config.twilio.number) return "would_call_ourselves";
  return null;
}

// After the intake ends, call the provider's number back as the carrier.
export function scheduleCarrierCallback(opts: HandoffOptions): boolean {
  // Prefer the number that just called us. If we could not learn it, fall back
  // to the demo phone from DEMO_CARRIER_NUMBER so the handoff still happens.
  let to = opts.to;
  if (blockedReason(to) && config.demoCarrierNumber) {
    console.log(`[handoff] no usable caller id, falling back to DEMO_CARRIER_NUMBER`);
    to = config.demoCarrierNumber;
  }

  const blocked = blockedReason(to);
  if (blocked) {
    console.log(`[handoff] no callback: ${blocked} (to=${opts.to || "-"})`);
    publish({
      kind: "handoff_skipped",
      callId: opts.fromCallId,
      transport: "phone",
      data: { reason: blocked, to: to || null },
    });
    return false;
  }

  // If they miss the callback and dial in instead, they should still land in
  // the negotiation rather than starting a fresh intake.
  expectCarrier(to);

  console.log(`[handoff] calling ${to} back as carrier in ${HANDOFF_DELAY_MS}ms`);
  publish({
    kind: "handoff_scheduled",
    callId: opts.fromCallId,
    transport: "phone",
    data: { to, delayMs: HANDOFF_DELAY_MS },
  });

  setTimeout(async () => {
    try {
      const call = await placeCall({ to, mode: "negotiate" });
      console.log(`[handoff] calling ${to} as carrier, sid=${call.sid}`);
    } catch (err: any) {
      console.error(`[handoff] callback failed: ${err.message}`);
      publish({
        kind: "handoff_failed",
        callId: opts.fromCallId,
        transport: "phone",
        data: { to, error: err.message, code: err.code },
      });
    }
  }, HANDOFF_DELAY_MS);

  return true;
}
