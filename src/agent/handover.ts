// -----------------------------------------------------------------------------
// agent/handover.ts
// The failsafe: the conversation has gone somewhere Volta should not be, so a
// person takes over.
//
// Triggers are deliberately broad — someone asking outright for a human, a
// complaint or a dispute, anything legal or financial beyond the booking, a
// caller who is upset, or simply a conversation Volta has lost the thread of.
// The cost of handing over unnecessarily is a wasted minute. The cost of not
// handing over is an agent improvising in a situation it was never given
// authority over.
//
// WHAT ACTUALLY HAPPENS TODAY: the call cannot be transferred. Twilio can do a
// warm transfer, but not while the media stream owns the call the way ours
// does — it would need the call to be re-pointed at new TwiML, and that is not
// built. So Volta says a person will pick this up and that they will have the
// full context, and then this module makes that true: it writes the summary,
// the decisions and the transcript to data/handovers.json and puts it on the
// dashboard. What is missing is the last hop — putting a human on the line.
// Nothing here pretends otherwise.
// -----------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import path from "node:path";

import { getCall } from "../store/calls.js";
import { getMandate } from "../store/mandates.js";
import { getAllNegotiations, getDecision } from "../store/negotiations.js";
import { currentBooking, pendingChange } from "../negotiation/escalation.js";
import { DATA_DIR, readJson, writeJson } from "../store/paths.js";

const FILE = path.join(DATA_DIR, "handovers.json");

export type Handover = {
  id: string;
  callId: string;
  // Volta's own words for why it is stepping out.
  reason: string;
  // What the caller asked for, if they said it plainly.
  askedFor?: string;
  createdAt: string;
  // Everything the person picking this up needs, without listening to the call.
  context: {
    phase: string;
    mandate: unknown;
    booking: unknown;
    pendingChange: unknown;
    decision: unknown;
    carriers: { name: string; status: string; priceMxn?: number }[];
    transcript: { who: string; text: string }[];
  };
};

type HandoverDb = { handovers: Handover[] };

let db: HandoverDb = readJson<HandoverDb>(FILE) ?? { handovers: [] };

// The conversation as a person would read it, newest last.
function transcriptOf(callId: string) {
  const call = getCall(callId);
  if (!call) return [];
  return call.log
    .filter((e) => e.kind === "user_transcript" || e.kind === "agent_transcript")
    .map((e) => ({
      who: e.kind === "user_transcript" ? "caller" : "volta",
      text: String(e.data ?? ""),
    }));
}

export function requestHandover(opts: {
  callId: string;
  phase: string;
  reason: string;
  askedFor?: string;
}): Handover {
  const handover: Handover = {
    id: randomUUID(),
    callId: opts.callId,
    reason: opts.reason,
    askedFor: opts.askedFor,
    createdAt: new Date().toISOString(),
    context: {
      phase: opts.phase,
      mandate: getMandate(),
      booking: currentBooking(),
      pendingChange: pendingChange(),
      decision: getDecision() ?? null,
      carriers: getAllNegotiations().map((c) => ({
        name: c.carrierName || "(unnamed)",
        status: c.status,
        priceMxn: c.final?.priceMxn ?? c.latest.priceMxn,
      })),
      transcript: transcriptOf(opts.callId),
    },
  };

  db.handovers.push(handover);
  writeJson(FILE, db);
  console.log(
    `[handover] a person is needed on call ${opts.callId.slice(0, 8)}: ${opts.reason}`
  );
  return handover;
}

export function lastHandover(): Handover | undefined {
  return db.handovers[db.handovers.length - 1];
}

export function allHandovers(): Handover[] {
  return db.handovers;
}

// Did this call end because it was handed to a person? Then the automatic
// follow-up calls must not fire: a person is taking it from here, and Volta
// ringing them back would cut across that.
export function wasHandedOver(callId: string): boolean {
  return db.handovers.some((h) => h.callId === callId);
}

export function clearHandovers(): void {
  db = { handovers: [] };
  writeJson(FILE, db);
}
