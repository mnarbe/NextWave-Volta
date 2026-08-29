// -----------------------------------------------------------------------------
// store/calls.ts
// In-memory state + console logging. Same as the phone version.
// -----------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import type { CallState, Mandate, LogEntry } from "../domain/types.js";

const calls = new Map<string, CallState>();

export function createCall(mandate: Mandate | null = null): string {
  const callId = randomUUID();
  calls.set(callId, { callId, mandate, commitments: [], log: [], refusals: 0 });
  return callId;
}

export function getCall(callId: string): CallState | undefined {
  return calls.get(callId);
}

export function log(callId: string, kind: LogEntry["kind"], data: unknown): void {
  const entry: LogEntry = { ts: new Date().toISOString(), callId, kind, data };
  const call = calls.get(callId);
  if (call) call.log.push(entry);
  const short = typeof data === "string" ? data : JSON.stringify(data);
  console.log(`[${entry.ts}] (${callId.slice(0, 8)}) ${kind}: ${short}`);
}
