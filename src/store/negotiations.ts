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
  CarrierNegotiation,
  CarrierOffer,
  Mandate,
} from "../domain/types.js";
import { NEGOTIATIONS_FILE, readJson, writeJson } from "./paths.js";

type Db = { updatedAt: string; carriers: CarrierNegotiation[] };

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

// Start (or recover) the negotiation record for a carrier.
export function beginNegotiation(
  callId: string,
  mandate?: Mandate | null
): CarrierNegotiation {
  let c = find(callId);
  if (!c) {
    c = {
      callId,
      carrierName: "",
      startedAt: new Date().toISOString(),
      offers: [],
      latest: { conditions: [] },
      refusals: 0,
      status: "in_progress",
      mandateSnapshot: mandate ?? null,
    };
    db.carriers.push(c);
    persist();
  } else if (mandate && !c.mandateSnapshot) {
    c.mandateSnapshot = mandate;
    persist();
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
  if (carrierName && carrierName.trim()) c.carrierName = carrierName.trim();

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
  return c;
}

export function getNegotiation(callId: string): CarrierNegotiation | undefined {
  return find(callId);
}

export function getAllNegotiations(): CarrierNegotiation[] {
  return db.carriers;
}

// New job (new mandate) -> clear the old negotiations.
export function resetNegotiations(): void {
  db = { updatedAt: new Date().toISOString(), carriers: [] };
  persist();
}
