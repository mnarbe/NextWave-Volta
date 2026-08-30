// -----------------------------------------------------------------------------
// negotiation/roster.ts
// The carriers a round negotiates against. Exactly ONE "human" (a person on the
// mic / phone) and any number of "sim" personas.
//
// Override the built-in demo roster by dropping a data/carriers.json with the
// same shape (an array of CarrierSpec).
// -----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "../config.js";
import type { CarrierSpec } from "../domain/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROSTER_FILE = path.join(__dirname, "..", "..", "data", "carriers.json");

// Demo roster: two scripted carriers + one seat for a human.
// Floors are set so "Fletes del Norte" is the cheapest clean option and
// "Transportes del Pacifico" only clears the cap after some pushback.
export const DEMO_ROSTER: CarrierSpec[] = [
  {
    id: "sim-norte",
    name: "Fletes del Norte",
    kind: "sim",
    email: "despacho@fletesdelnorte.mx",
    persona: {
      askPriceMxn: 9600,
      floorPriceMxn: 7400,
      conditions: [],
      stubbornness: "low",
      style: "Eager for the load, concedes quickly, no-nonsense.",
    },
  },
  {
    id: "sim-pacifico",
    name: "Transportes del Pacifico",
    kind: "sim",
    email: "operaciones@tpacifico.mx",
    persona: {
      askPriceMxn: 11200,
      floorPriceMxn: 8600,
      conditions: ["48h advance notice"],
      stubbornness: "high",
      style: "Busy carrier, holds price hard, only moves in small steps.",
    },
  },
  {
    id: "human-1",
    name: "Transportes Uribe",
    kind: "human",
    email: "dispatch@transportesuribe.mx",
    // The phone Volta dials for this carrier, and the caller ID it recognises
    // them by when they ring in. Override with DEMO_CARRIER_NUMBER in .env.
    phone: config.demoCarrierNumber || "+5493454019058",
  },
];

// Which carrier is calling from this number? Lets Volta greet a carrier by
// name and pick up their standing quote when they ring in on their own —
// to push a delay, or to change their price.
export function findCarrierByPhone(phone: string | undefined): CarrierSpec | undefined {
  if (!phone) return undefined;
  const key = phone.replace(/[^\d+]/g, "");
  return loadRoster().find((c) => c.phone && c.phone.replace(/[^\d+]/g, "") === key);
}

function isSpec(x: any): x is CarrierSpec {
  return (
    x &&
    typeof x.id === "string" &&
    typeof x.name === "string" &&
    (x.kind === "human" || x.kind === "sim")
  );
}

export function loadRoster(override?: unknown): CarrierSpec[] {
  // 1) explicit override from the request body
  if (Array.isArray(override) && override.every(isSpec)) return override as CarrierSpec[];

  // 2) data/carriers.json
  try {
    const parsed = JSON.parse(fs.readFileSync(ROSTER_FILE, "utf8"));
    if (Array.isArray(parsed) && parsed.every(isSpec)) return parsed;
    console.warn("[roster] data/carriers.json has an unexpected shape — using the demo roster.");
  } catch {
    /* no file: fall through to the demo roster */
  }

  // 3) built-in demo roster
  return DEMO_ROSTER;
}

// Look a carrier up by the id stamped on its negotiation record.
export function findCarrierById(id: string | undefined): CarrierSpec | undefined {
  if (!id) return undefined;
  return loadRoster().find((c) => c.id === id);
}
