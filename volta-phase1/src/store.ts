// -----------------------------------------------------------------------------
// store.ts
// Almacenamiento en memoria para Fase 1. Un Map de callId -> CallState.
// Para el hackathon alcanza; en Fase 2/3 esto se reemplaza por SQLite/Postgres
// sin tocar el resto del código (mismas funciones).
// -----------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import type { CallState, Mandate, LogEntry } from "./types.js";

const calls = new Map<string, CallState>();

// Crea el estado de una llamada nueva y devuelve su callId.
export function createCall(mandate: Mandate): string {
  const callId = randomUUID();
  calls.set(callId, { callId, mandate, commitments: [], log: [] });
  return callId;
}

export function getCall(callId: string): CallState | undefined {
  return calls.get(callId);
}

// Escribe una entrada de log Y la imprime en consola, para que durante el
// hackathon veas todo en vivo en la terminal.
export function log(callId: string, kind: LogEntry["kind"], data: unknown): void {
  const entry: LogEntry = { ts: new Date().toISOString(), callId, kind, data };
  const call = calls.get(callId);
  if (call) call.log.push(entry);

  // Log legible en consola. Los transcripts y tool calls son los más útiles.
  const short = typeof data === "string" ? data : JSON.stringify(data);
  console.log(`[${entry.ts}] (${callId.slice(0, 8)}) ${kind}: ${short}`);
}
