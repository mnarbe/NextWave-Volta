// -----------------------------------------------------------------------------
// telephony/handoff.ts
// What happens AFTER a call ends.
//
// When the intake with the provider finishes, Volta opens a ROUND: the scripted
// carriers start negotiating straight away, and the human carrier's seat is
// filled by ringing their phone. So one intake call kicks off the whole
// comparison without anyone pressing a button.
//
// Any future "and then call X" rule belongs here, not inside the media stream.
// -----------------------------------------------------------------------------
import { config, twilioReady } from "../config.js";
import { publish } from "../bus.js";
import { placeCall } from "./twilio.js";
import { expectCarrier } from "./routing.js";
import { dialWhenFree } from "./line.js";
import { startRound } from "../negotiation/round.js";
import { loadRoster } from "../negotiation/roster.js";

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

// After the intake ends: open the round, then bring the human carrier in.
//
// The scripted carriers start negotiating the moment the round opens, so by the
// time the phone rings they are already quoting. The human's call claims the
// seat the round is holding for them.
export function scheduleCarrierCallback(opts: HandoffOptions): boolean {
  // The human carrier's own number from the roster wins: that is the carrier
  // Volta means to reach. The number that just called us (the provider) is the
  // fallback, and DEMO_CARRIER_NUMBER after that — in the demo all three are
  // the same phone, but they are not the same thing.
  const rosterPhone = loadRoster().find((c) => c.kind === "human")?.phone;
  let to = rosterPhone || opts.to;
  // Fall back only when the NUMBER is the problem. If Twilio itself is not
  // configured, another number will not help.
  if (!/^\+[1-9]\d{6,15}$/.test(to) && config.demoCarrierNumber) {
    console.log(`[handoff] no usable number, falling back to DEMO_CARRIER_NUMBER`);
    to = config.demoCarrierNumber;
  }

  // Open the round FIRST, and independently of whether we can dial anyone. The
  // scripted carriers negotiate on their own, so the comparison still happens
  // even if the human's phone is unreachable — they can always join by calling
  // the carrier line themselves.
  let roundId: string | undefined;
  try {
    const round = startRound();
    roundId = round.roundId;
    console.log(
      `[handoff] round ${roundId.slice(0, 8)} open against ` +
        `${round.carriers.map((c) => c.name).join(", ")}`
    );
  } catch (err: any) {
    // No mandate, or a roster problem: there is nothing to compare against.
    console.warn(`[handoff] could not open a round: ${err.message}`);
    publish({
      kind: "round_start_failed",
      callId: opts.fromCallId,
      transport: "sim",
      data: { error: err.message },
    });
  }

  const blocked = blockedReason(to);
  if (blocked) {
    console.log(`[handoff] round is running, but cannot ring the carrier: ${blocked}`);
    publish({
      kind: "handoff_skipped",
      callId: opts.fromCallId,
      transport: "phone",
      data: { reason: blocked, to: to || null, roundId },
    });
    // The round is still live and holding their seat: they can call in.
    return Boolean(roundId);
  }

  // If they miss the callback and dial in instead, they should still land in
  // the negotiation rather than starting a fresh intake.
  expectCarrier(to);

  console.log(`[handoff] calling ${to} as the human carrier in ${HANDOFF_DELAY_MS}ms`);
  publish({
    kind: "handoff_scheduled",
    callId: opts.fromCallId,
    transport: "phone",
    data: { to, delayMs: HANDOFF_DELAY_MS, roundId },
  });

  // The intake call may still be hanging up as this fires.
  dialWhenFree(async () => {
    try {
      const call = await placeCall({ to, mode: "negotiate", intent: "quote" });
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
