// -----------------------------------------------------------------------------
// negotiationStore.ts
// Estado de la NEGOCIACIÓN con los carriers, para el dashboard y para la fase
// siguiente (comunicarle al cliente lo que consiguió Volta).
//
// Un registro por llamada a un carrier (callId). Guarda:
//   - qué pidió el cliente (snapshot del mandato),
//   - cada oferta / condición / demora que dijo el carrier (historial completo),
//   - la decisión final (trato / sin trato) y qué hay que comunicarle al cliente.
//
// Persiste en data/negotiations.json. Se reinicia cuando entra un mandato nuevo
// (arranca un trabajo nuevo) para que el panel muestre solo el trabajo actual.
// -----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Mandate } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "negotiations.json");

// Una oferta puntual del carrier: lo que dijo en un momento de la charla.
export type CarrierOffer = {
  ts: string;
  priceMxn?: number;
  pickupTime?: string;
  pickupDelayDays?: number; // >0 = más tarde que la ventana pedida por el cliente
  delayNote?: string; // texto libre sobre el desvío de fecha ("recién el viernes")
  conditions: string[]; // condiciones / salvedades que ata el carrier
  note?: string;
};

export type CarrierFinal = {
  outcome: "deal" | "no_deal";
  priceMxn?: number;
  pickupTime?: string;
  pickupDelayDays?: number;
  delayNote?: string;
  conditionsToRelay: string[]; // lo que hay que comunicarle al cliente
  priceWithinCap?: boolean;
  summary?: string;
  decidedAt: string;
};

export type CarrierNegotiation = {
  callId: string;
  carrierName: string;
  startedAt: string;
  offers: CarrierOffer[];
  // Vista consolidada: último valor no vacío de cada campo + unión de condiciones.
  latest: {
    priceMxn?: number;
    pickupTime?: string;
    pickupDelayDays?: number;
    delayNote?: string;
    conditions: string[];
  };
  refusals: number;
  status: "in_progress" | "deal" | "no_deal";
  final?: CarrierFinal;
  mandateSnapshot?: Mandate | null;
};

type Db = { updatedAt: string; carriers: CarrierNegotiation[] };

let db: Db = load();

function load(): Db {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as Db;
  } catch {
    return { updatedAt: new Date().toISOString(), carriers: [] };
  }
}

function persist(): void {
  db.updatedAt = new Date().toISOString();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2), "utf8");
}

function find(callId: string): CarrierNegotiation | undefined {
  return db.carriers.find((c) => c.callId === callId);
}

function addCondition(list: string[], cond: string): void {
  const c = cond.trim();
  if (c && !list.some((x) => x.toLowerCase() === c.toLowerCase())) list.push(c);
}

// Arranca (o recupera) el registro de la negociación con un carrier.
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

// Registra una oferta / condición / demora dicha por el carrier.
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

// Cierra la negociación: fija la decisión final y qué comunicarle al cliente.
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

// Trabajo nuevo (nuevo mandato) -> limpiamos las negociaciones viejas.
export function resetNegotiations(): void {
  db = { updatedAt: new Date().toISOString(), carriers: [] };
  persist();
}
