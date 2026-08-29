// -----------------------------------------------------------------------------
// storage/mandateStore.ts
// El "lugar donde queda guardado" el mandato que Volta captura del cliente, para
// que la fase de negociación con los carriers lo pueda leer aunque se reinicie
// el server.
//
// No toca el disco: eso es persistence.ts.
// -----------------------------------------------------------------------------
import { jsonCollection } from "./persistence.js";
import type { NegotiationMandate } from "../types.js";

const mandate = jsonCollection<NegotiationMandate | null>("mandate.json", () => null);

// SYNC-READ: lo llama resolveMandate() en session.ts, que no puede esperar.
export function getMandate(): NegotiationMandate | null {
  return mandate.read();
}

export function saveMandate(value: NegotiationMandate): NegotiationMandate {
  return mandate.write(value)!;
}

export const MANDATE_LOCATION = mandate.location;
