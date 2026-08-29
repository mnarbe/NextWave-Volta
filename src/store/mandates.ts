// -----------------------------------------------------------------------------
// store/mandates.ts
// Where the mandate Volta captures from the client is kept. Persisted to
// data/mandate.json so the next phases (negotiating with the 3 carriers) can
// read it even after a server restart.
// -----------------------------------------------------------------------------
import type { NegotiationMandate } from "../domain/types.js";
import { MANDATE_FILE, readJson, writeJson } from "./paths.js";

let current: NegotiationMandate | null = readJson<NegotiationMandate>(MANDATE_FILE);

export function getMandate(): NegotiationMandate | null {
  return current;
}

export function saveMandate(mandate: NegotiationMandate): NegotiationMandate {
  current = mandate;
  writeJson(MANDATE_FILE, mandate);
  return mandate;
}

export { MANDATE_FILE };
