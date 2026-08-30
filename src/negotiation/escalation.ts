// -----------------------------------------------------------------------------
// negotiation/escalation.ts
// What happens when a carrier we ALREADY booked calls back and changes
// something: a higher price, a pickup that slips out of the window, a truck
// that broke, a destination they cannot reach.
//
// The rule the client gave us:
//   - the change still fits the original mandate  -> Volta decides on its own;
//   - it does not                                 -> Volta cannot decide. It
//     tells the carrier it has to check with the client, calls the provider,
//     explains, and asks them. Their answer sends Volta back to the carrier
//     either to confirm the change or to cancel.
//
// WHICH of the two it is, is decided HERE, in code, by checkMandate — never by
// the model. Getting that wrong means either committing the client to something
// they never authorised, or waking them up for a change that did not need them.
// -----------------------------------------------------------------------------
import { randomUUID } from "node:crypto";

import { checkMandate } from "../domain/mandate.js";
import { getDecision, getNegotiation } from "../store/negotiations.js";
import path from "node:path";

import { DATA_DIR, readJson, writeJson } from "../store/paths.js";
import type { Mandate } from "../domain/types.js";

// What the carrier is asking to change. Everything optional: they might only
// move the pickup, or only say the truck is dead.
export type RequestedChange = {
  priceMxn?: number;
  pickupTime?: string;
  conditions?: string[];
  // They cannot do the job at all (truck broken, cannot reach the destination).
  cannotDo?: boolean;
  note?: string;
};

export type ChangeRequest = {
  id: string;
  carrierId?: string;
  carrierName: string;
  // The negotiation record of the booking they are changing.
  bookingCallId: string;
  // What was agreed before this call.
  agreed: { priceMxn?: number; pickupTime?: string; conditions: string[] };
  requested: RequestedChange;
  // Does the new picture still fit the mandate the provider gave us?
  withinMandate: boolean;
  reasons: string[];
  status: "auto_accepted" | "awaiting_provider" | "approved" | "rejected";
  createdAt: string;
  decidedAt?: string;
  providerNote?: string;
};

type ChangeDb = { pending: ChangeRequest | null; history: ChangeRequest[] };

const FILE = path.join(DATA_DIR, "changes.json");

function load(): ChangeDb {
  return readJson<ChangeDb>(FILE) ?? { pending: null, history: [] };
}

let db: ChangeDb = load();

function persist(): void {
  writeJson(FILE, db);
}

// The deal Volta currently holds, if any: the winner of the last round.
export function currentBooking() {
  const decision = getDecision();
  if (!decision || decision.outcome !== "deal" || !decision.winnerCallId) return null;
  const neg = getNegotiation(decision.winnerCallId);
  if (!neg?.final) return null;
  return {
    callId: neg.callId,
    carrierId: neg.carrierId,
    carrierName: neg.carrierName || "the carrier",
    priceMxn: neg.final.priceMxn,
    pickupTime: neg.final.pickupTime,
    conditions: neg.final.conditionsToRelay ?? [],
  };
}

// Is this carrier the one we booked? Used to decide whether a call-back is a
// change to an existing deal or just another quote.
export function isBookedCarrier(carrierId?: string, callId?: string): boolean {
  const b = currentBooking();
  if (!b) return false;
  return (carrierId != null && b.carrierId === carrierId) || b.callId === callId;
}

// Evaluate a change against the mandate and record it. Returns the request with
// `withinMandate` already decided.
export function evaluateChange(opts: {
  mandate: Mandate | null;
  carrierId?: string;
  carrierName?: string;
  bookingCallId?: string;
  requested: RequestedChange;
  // What was agreed before this change. Defaults to the booking on file;
  // passed explicitly by tests so they do not depend on disk state.
  agreed?: { priceMxn?: number; pickupTime?: string; conditions?: string[] };
}): ChangeRequest {
  const booking = currentBooking();
  const agreed = {
    priceMxn: opts.agreed?.priceMxn ?? booking?.priceMxn,
    pickupTime: opts.agreed?.pickupTime ?? booking?.pickupTime,
    conditions: opts.agreed?.conditions ?? booking?.conditions ?? [],
  };

  // The picture AFTER the change: whatever they did not touch stays as agreed.
  const priceMxn = opts.requested.priceMxn ?? agreed.priceMxn;
  const pickupTime = opts.requested.pickupTime ?? agreed.pickupTime;
  const conditions = opts.requested.conditions?.length
    ? opts.requested.conditions
    : agreed.conditions;

  let withinMandate: boolean;
  let reasons: string[];

  if (opts.requested.cannotDo) {
    // Not a term we can weigh: they are out. Always the provider's call.
    withinMandate = false;
    reasons = ["The carrier cannot do the job at all."];
  } else if (!opts.mandate) {
    withinMandate = false;
    reasons = ["No mandate on file to check the change against."];
  } else if (priceMxn == null || !pickupTime) {
    withinMandate = false;
    reasons = ["The change is missing a price or a pickup time to check."];
  } else {
    const check = checkMandate(opts.mandate, { priceMxn, pickupTime, conditions });
    withinMandate = check.decision === "allowed";
    reasons = check.reasons;
  }

  const request: ChangeRequest = {
    id: randomUUID(),
    carrierId: opts.carrierId ?? booking?.carrierId,
    carrierName: opts.carrierName || booking?.carrierName || "the carrier",
    bookingCallId: opts.bookingCallId || booking?.callId || "",
    agreed,
    requested: opts.requested,
    withinMandate,
    reasons,
    status: withinMandate ? "auto_accepted" : "awaiting_provider",
    createdAt: new Date().toISOString(),
  };

  db.pending = withinMandate ? null : request;
  db.history.push(request);
  persist();
  return request;
}

// The change waiting on the provider's answer, if any.
export function pendingChange(): ChangeRequest | null {
  return db.pending;
}

// The provider answered. Returns the resolved request so the caller knows who
// to ring back and what to tell them.
export function resolveChange(approved: boolean, note?: string): ChangeRequest | null {
  const p = db.pending;
  if (!p) return null;
  p.status = approved ? "approved" : "rejected";
  p.decidedAt = new Date().toISOString();
  p.providerNote = note;
  db.pending = null;
  const idx = db.history.findIndex((h) => h.id === p.id);
  if (idx >= 0) db.history[idx] = p;
  persist();
  return p;
}

// The last change we resolved, so the call-back to the carrier knows what to
// say without being told again.
export function lastResolvedChange(): ChangeRequest | undefined {
  return [...db.history].reverse().find((h) => h.status === "approved" || h.status === "rejected");
}

export function clearChanges(): void {
  db = { pending: null, history: [] };
  persist();
}
