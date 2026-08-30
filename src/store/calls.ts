// -----------------------------------------------------------------------------
// store/calls.ts
// In-memory state + console logging. Same as the phone version.
// -----------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import type { CallState, Commitment, Mandate, LogEntry } from "../domain/types.js";

const calls = new Map<string, CallState>();

// `id` lets a caller (a round) pre-create a call under a known id; the call is
// created only once, so a later startSession using the same id is a no-op.
export function createCall(mandate: Mandate | null = null, id?: string): string {
  const callId = id ?? randomUUID();
  if (!calls.has(callId)) {
    calls.set(callId, { callId, mandate, commitments: [], log: [], refusals: 0 });
  }
  return callId;
}

export function getCall(callId: string): CallState | undefined {
  return calls.get(callId);
}

// Commitments live inside their call. The confirmation links arrive knowing only
// the commitment id, so we scan — there are a handful of calls in a demo, and
// keeping a second index in sync would be more to get wrong than it saves.
export function findCommitment(
  commitmentId: string
): { call: CallState; commitment: Commitment } | undefined {
  for (const call of calls.values()) {
    const commitment = call.commitments.find((c) => c.id === commitmentId);
    if (commitment) return { call, commitment };
  }
  return undefined;
}

export function log(callId: string, kind: LogEntry["kind"], data: unknown): void {
  const entry: LogEntry = { ts: new Date().toISOString(), callId, kind, data };
  const call = calls.get(callId);
  if (call) call.log.push(entry);
  const short = typeof data === "string" ? data : JSON.stringify(data);
  console.log(`[${entry.ts}] (${callId.slice(0, 8)}) ${kind}: ${short}`);
}
