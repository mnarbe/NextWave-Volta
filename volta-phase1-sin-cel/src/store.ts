// -----------------------------------------------------------------------------
// store.ts
// Estado en memoria + logging a consola. Igual que la versión con teléfono.
// -----------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import type { CallState, Mandate, LogEntry } from "./types.js";

const calls = new Map<string, CallState>();

// Reloj de audio por llamada. Lo instala el transporte que sí sabe cuánto audio
// pasó (Twilio: media.timestamp). Sin transporte telefónico simplemente no hay.
const audioClocks = new Map<string, () => number>();

export function setAudioClock(callId: string, clock: () => number): void {
  audioClocks.set(callId, clock);
}

export function audioMsOf(callId: string): number | undefined {
  try {
    return audioClocks.get(callId)?.();
  } catch {
    return undefined;
  }
}

export function createCall(mandate: Mandate | null = null): string {
  const callId = randomUUID();
  calls.set(callId, { callId, mandate, commitments: [], log: [], refusals: 0 });
  return callId;
}

export function getCall(callId: string): CallState | undefined {
  return calls.get(callId);
}

export function endCall(callId: string): void {
  audioClocks.delete(callId);
}

export function log(callId: string, kind: LogEntry["kind"], data: unknown): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    audioMs: audioMsOf(callId),
    callId,
    kind,
    data,
  };
  const call = calls.get(callId);
  if (call) call.log.push(entry);
  const short = typeof data === "string" ? data : JSON.stringify(data);
  console.log(`[${entry.ts}] (${callId.slice(0, 8)}) ${kind}: ${short}`);
}
