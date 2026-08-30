// -----------------------------------------------------------------------------
// telephony/winner-call.ts
// The last leg of a round: once every carrier has quoted and the comparator has
// picked a winner, Volta calls that carrier BACK to confirm and book — which is
// exactly what it promised each of them on the first call.
//
// Only the human carrier gets a real phone call: the scripted ones are text
// personas, so their "confirmation" is recorded without dialling anyone.
//
// This lives in telephony/ rather than in negotiation/round.ts on purpose: the
// round decides WHO won, this decides WHAT WE DO about it. It reacts to the
// round_done event like any other subscriber.
// -----------------------------------------------------------------------------
import { config, twilioReady } from "../config.js";
import { publish, subscribe } from "../bus.js";
import { getNegotiation } from "../store/negotiations.js";
import { placeCall } from "./twilio.js";
import { expectCarrier } from "./routing.js";
import { loadRoster } from "../negotiation/roster.js";
import type { RoundDecision } from "../domain/types.js";

// Breather between the round closing and the confirmation call, so the human
// is not rung the instant they hang up.
const CONFIRM_DELAY_MS = 3000;

// The number to ring for a given carrier: the one on its roster entry, falling
// back to the demo phone.
function phoneFor(carrierId: string | undefined): string {
  const spec = loadRoster().find((c) => c.id === carrierId);
  return spec?.phone || config.demoCarrierNumber || "";
}

export function callWinner(decision: RoundDecision): void {
  if (decision.outcome !== "deal" || !decision.winnerCallId) {
    console.log(`[winner] no deal to confirm (${decision.reason})`);
    return;
  }

  const neg = getNegotiation(decision.winnerCallId);
  if (!neg) return;

  // A scripted carrier has no phone. Nothing to dial: the round result already
  // records the win, and the dashboard shows it.
  if (neg.kind !== "human") {
    console.log(`[winner] ${neg.carrierName} won — scripted carrier, no call to place`);
    publish({
      kind: "winner_recorded",
      callId: decision.winnerCallId,
      transport: "sim",
      data: { carrierName: neg.carrierName, priceMxn: neg.final?.priceMxn },
    });
    return;
  }

  const to = phoneFor(neg.carrierId);
  if (!twilioReady() || !/^\+[1-9]\d{6,15}$/.test(to)) {
    console.log(`[winner] ${neg.carrierName} won but there is no number to call back`);
    publish({
      kind: "winner_call_skipped",
      callId: decision.winnerCallId,
      transport: "phone",
      data: { carrierName: neg.carrierName, reason: to ? "twilio_not_ready" : "no_number" },
    });
    return;
  }

  console.log(`[winner] ${neg.carrierName} won — confirming by phone in ${CONFIRM_DELAY_MS}ms`);
  publish({
    kind: "winner_call_scheduled",
    callId: decision.winnerCallId,
    transport: "phone",
    data: { carrierName: neg.carrierName, to, delayMs: CONFIRM_DELAY_MS },
  });

  // If they call in instead of picking up, they are still the carrier.
  expectCarrier(to);

  setTimeout(async () => {
    try {
      const call = await placeCall({
        to,
        mode: "negotiate",
        carrier: neg.carrierName,
        confirming: true,
      });
      console.log(`[winner] confirmation call to ${to}, sid=${call.sid}`);
    } catch (err: any) {
      console.error(`[winner] confirmation call failed: ${err.message}`);
      publish({
        kind: "winner_call_failed",
        callId: decision.winnerCallId!,
        transport: "phone",
        data: { carrierName: neg.carrierName, error: err.message },
      });
    }
  }, CONFIRM_DELAY_MS);
}

// Wired once at boot (src/index.ts).
export function watchRounds(): void {
  subscribe((evt) => {
    if (evt.kind === "round_done") callWinner(evt.data as RoundDecision);
  });
}
