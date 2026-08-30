// -----------------------------------------------------------------------------
// store/negotiations.ts
// State of the NEGOTIATION with carriers, for the dashboard and for the next
// phase (telling the client what Volta got).
//
// One record per carrier call (callId). It keeps:
//   - what the client asked for (mandate snapshot),
//   - every offer / condition / delay the carrier stated (full history),
//   - the final decision (deal / no deal) and what to relay to the client.
//
// The types live in domain/types.ts; this file is persistence only.
// Persisted to data/negotiations.json. Reset when a new mandate comes in (a new
// job starts) so the dashboard only shows the current job.
// -----------------------------------------------------------------------------
import type {
  CarrierKind,
  CarrierNegotiation,
  CarrierOffer,
  Mandate,
  RoundDecision,
} from "../domain/types.js";
import { compareCarriers } from "../domain/compare.js";
import { NEGOTIATIONS_FILE, readJson, writeJson } from "./paths.js";
import { exportNegotiation, exportRound } from "./firebase.js";

// Round metadata attached to a carrier's negotiation record.
export type CarrierMeta = {
  carrierId?: string;
  carrierName?: string;
  kind?: CarrierKind;
  roundId?: string;
};

type Db = {
  updatedAt: string;
  carriers: CarrierNegotiation[];
  roundId?: string;
  decision?: RoundDecision;
};

let db: Db = load();

function load(): Db {
  return (
    readJson<Db>(NEGOTIATIONS_FILE) ?? {
      updatedAt: new Date().toISOString(),
      carriers: [],
    }
  );
}

function persist(): void {
  db.updatedAt = new Date().toISOString();
  writeJson(NEGOTIATIONS_FILE, db);
}

function find(callId: string): CarrierNegotiation | undefined {
  return db.carriers.find((c) => c.callId === callId);
}

function addCondition(list: string[], cond: string): void {
  const c = cond.trim();
  if (c && !list.some((x) => x.toLowerCase() === c.toLowerCase())) list.push(c);
}

// Start (or recover) the negotiation record for a carrier. `meta` tags the
// record with its place in a round (carrier id / kind / roundId); it is optional
// so the plain single-carrier flow is unchanged.
export function beginNegotiation(
  callId: string,
  mandate?: Mandate | null,
  meta?: CarrierMeta
): CarrierNegotiation {
  let c = find(callId);
  if (!c) {
    c = {
      callId,
      carrierName: meta?.carrierName ?? "",
      startedAt: new Date().toISOString(),
      offers: [],
      latest: { conditions: [] },
      refusals: 0,
      status: "in_progress",
      mandateSnapshot: mandate ?? null,
      carrierId: meta?.carrierId,
      kind: meta?.kind,
      roundId: meta?.roundId,
    };
    db.carriers.push(c);
    persist();
  } else {
    let touched = false;
    if (mandate && !c.mandateSnapshot) ((c.mandateSnapshot = mandate), (touched = true));
    if (meta?.carrierName && !c.carrierName) ((c.carrierName = meta.carrierName), (touched = true));
    if (meta?.carrierId && !c.carrierId) ((c.carrierId = meta.carrierId), (touched = true));
    if (meta?.kind && !c.kind) ((c.kind = meta.kind), (touched = true));
    if (meta?.roundId && !c.roundId) ((c.roundId = meta.roundId), (touched = true));
    if (touched) persist();
  }
  return c;
}

// Record an offer / condition / delay stated by the carrier.
export function recordOffer(
  callId: string,
  carrierName: string | undefined,
  offer: CarrierOffer
): CarrierNegotiation {
  const c = find(callId) ?? beginNegotiation(callId);
  // In a round the name comes from the roster (c.carrierId is set) — don't let
  // the model's guess overwrite it. Outside a round, take what Volta learned.
  if (carrierName && carrierName.trim() && !c.carrierId) c.carrierName = carrierName.trim();

  c.offers.push(offer);

  if (offer.priceMxn != null) c.latest.priceMxn = offer.priceMxn;
  if (offer.pickupTime) c.latest.pickupTime = offer.pickupTime;
  if (offer.pickupDelayDays != null) c.latest.pickupDelayDays = offer.pickupDelayDays;
  if (offer.delayNote) c.latest.delayNote = offer.delayNote;
  for (const cond of offer.conditions) addCondition(c.latest.conditions, cond);

  persist();
  return c;
}

export function recordRefusal(callId: string, count: number): void {
  const c = find(callId);
  if (c) {
    c.refusals = count;
    persist();
  }
}

// Close the negotiation: set the final decision and what to relay to the client.
export function finalizeNegotiation(
  callId: string,
  input: {
    outcome: "deal" | "no_deal";
    finalPriceMxn?: number;
    finalPickupTime?: string;
    pickupDelayDays?: number;
    delayNote?: string;
    conditionsToRelay?: string[];
    summary?: string;
    mandate?: Mandate | null;
  }
): CarrierNegotiation {
  const c = find(callId) ?? beginNegotiation(callId, input.mandate);

  const relay: string[] = [];
  for (const cond of input.conditionsToRelay?.length
    ? input.conditionsToRelay
    : c.latest.conditions)
    addCondition(relay, cond);

  const priceMxn = input.finalPriceMxn ?? c.latest.priceMxn;
  const cap = (input.mandate ?? c.mandateSnapshot)?.maxPriceMxn;

  c.final = {
    outcome: input.outcome,
    priceMxn,
    pickupTime: input.finalPickupTime ?? c.latest.pickupTime,
    pickupDelayDays: input.pickupDelayDays ?? c.latest.pickupDelayDays,
    delayNote: input.delayNote ?? c.latest.delayNote,
    conditionsToRelay: relay,
    priceWithinCap:
      priceMxn != null && cap != null ? priceMxn <= cap : undefined,
    summary: input.summary,
    decidedAt: new Date().toISOString(),
  };
  c.status = input.outcome;

  persist();
  // Mirror the closed negotiation to Firestore (best-effort, non-blocking).
  exportNegotiation(c);
  return c;
}

export function getNegotiation(callId: string): CarrierNegotiation | undefined {
  return find(callId);
}

export function getAllNegotiations(): CarrierNegotiation[] {
  return db.carriers;
}

// New job (new mandate) -> clear the old negotiations and any round decision.
export function resetNegotiations(): void {
  db = { updatedAt: new Date().toISOString(), carriers: [] };
  persist();
}

// -----------------------------------------------------------------------------
// ROUND
// -----------------------------------------------------------------------------

// Tag the current set of negotiations as belonging to a round.
export function setRound(roundId: string): void {
  db.roundId = roundId;
  db.decision = undefined;
  persist();
}

export function getRoundId(): string | undefined {
  return db.roundId;
}

// Close the round: run the comparator over every carrier and store the winner.
export function finalizeRound(mandate: Mandate | null): RoundDecision {
  const decision: RoundDecision = {
    ...compareCarriers(db.carriers, mandate),
    roundId: db.roundId ?? "",
    decidedAt: new Date().toISOString(),
  };
  db.decision = decision;
  persist();
  exportRound(decision);
  return decision;
}

export function getDecision(): RoundDecision | undefined {
  return db.decision;
}

// The last quote this carrier gave us, from an EARLIER call (any round). Lets
// Volta open a call-back with what they already offered instead of starting
// from zero. `exceptCallId` skips the call currently in progress.
export function lastQuoteFor(
  carrierId: string,
  exceptCallId?: string
): { priceMxn?: number; pickupTime?: string; conditions?: string[] } | undefined {
  const past = db.carriers
    .filter((c) => c.carrierId === carrierId && c.callId !== exceptCallId)
    .sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""));
  const last = past[past.length - 1];
  if (!last) return undefined;
  const src = last.final ?? last.latest;
  if (src.priceMxn == null && !src.pickupTime) return undefined;
  return {
    priceMxn: src.priceMxn,
    pickupTime: src.pickupTime,
    conditions: last.final?.conditionsToRelay ?? last.latest.conditions,
  };
}
