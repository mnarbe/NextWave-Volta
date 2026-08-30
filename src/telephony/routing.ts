// -----------------------------------------------------------------------------
// telephony/routing.ts
// WHO is on the other end of a call, which is a different question from who
// dialled whom.
//
//   party  = who Volta is talking to: the provider (hands over the job and the
//            price cap) or a carrier (quotes to move the container).
//   phase  = the script Volta runs for that party (intake / negotiate).
//   direction = inbound or outbound. Independent of both.
//
// Keeping these apart is what lets all four flows work off the same number:
//   provider -> Volta   (inbound, intake)     <- today's demo
//   Volta   -> carrier  (outbound, negotiate) <- today's demo, and POST /call
//   carrier -> Volta    (inbound, negotiate)
//   Volta   -> provider (outbound, intake)    <- POST /call with mode "intake"
//
// The only thing that ever needed deciding is the party of an INBOUND call,
// and that is resolveInboundParty() below. Everywhere else the party is
// explicit.
// -----------------------------------------------------------------------------
import { config } from "../config.js";
import type { Phase } from "../agent/realtime.js";

export type Party = "provider" | "carrier";

export function phaseFor(party: Party): Phase {
  return party === "carrier" ? "negotiate" : "intake";
}

export function partyFor(phase: Phase): Party {
  return phase === "negotiate" ? "carrier" : "provider";
}

// Numbers we are expecting to hear from as a CARRIER, with an expiry.
// Volta puts a number in here when it is about to call it back for the
// negotiation, so that if the person misses the callback and dials in instead,
// they still land in the negotiation and do not start a brand new intake (which
// would wipe the mandate we just captured).
const expectedCarriers = new Map<string, number>();

const DEFAULT_TTL_MS = 15 * 60_000;

function key(number: string): string {
  return number.replace(/[^\d+]/g, "");
}

export function expectCarrier(number: string, ttlMs = DEFAULT_TTL_MS): void {
  if (!number) return;
  expectedCarriers.set(key(number), Date.now() + ttlMs);
}

export function forgetCarrier(number: string): void {
  if (number) expectedCarriers.delete(key(number));
}

function isExpectedCarrier(number: string): boolean {
  const until = expectedCarriers.get(key(number));
  if (until == null) return false;
  if (Date.now() > until) {
    expectedCarriers.delete(key(number));
    return false;
  }
  return true;
}

// Someone is calling one of Volta's numbers. Who do we think it is?
//
// In order of confidence:
//   1. WHICH NUMBER they dialled. If TWILIO_CARRIER_NUMBER is set, calls to it
//      are carriers and calls to the main number are the provider. No guessing.
//   2. Whether we were expecting them as a carrier (Volta just took a brief
//      from that number and is about to ring it back).
//   3. Otherwise: the provider.
//
// This is the ONE function that decides it. A directory of known carrier
// numbers, or an IVR that just asks, both slot in here and nowhere else.
export function resolveInboundParty(from: string | undefined, to?: string): Party {
  if (config.twilio.carrierNumber && to) {
    if (key(to) === key(config.twilio.carrierNumber)) return "carrier";
    if (key(to) === key(config.twilio.number)) return "provider";
  }
  if (from && isExpectedCarrier(from)) return "carrier";
  return "provider";
}
