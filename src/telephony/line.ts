// -----------------------------------------------------------------------------
// telephony/line.ts
// Is there a phone call in progress right now, and when is it safe to place the
// next one?
//
// Every automatic follow-up call in this system fires off the back of something
// that happens DURING a call — the round decides its winner while Volta is
// still saying goodbye to the last carrier, the escalation is triggered by a
// tool the carrier's call just ran. Waiting a few seconds from that moment is
// not the same as waiting for the line to be free: on a long goodbye Volta
// would ring the same person while they are still on the phone with it.
//
// So: wait for the current call to actually end, THEN pause a breath, then dial.
// -----------------------------------------------------------------------------
import { subscribe } from "../bus.js";

// Breathing room after the previous call really hangs up. Long enough for
// Twilio to tear it down and for the person to take the phone off their ear.
export const SETTLE_MS = 3000;

// If a call never reports its end (dropped socket, crash), do not wait forever.
const MAX_WAIT_MS = 45_000;

const liveCalls = new Set<string>();
const waiters: Array<() => void> = [];

// Wired once at boot, from src/index.ts.
export function watchLine(): void {
  subscribe((evt) => {
    if (evt.transport !== "phone") return;
    if (evt.kind === "phone_call_started") {
      liveCalls.add(evt.callId);
    } else if (evt.kind === "phone_call_ended") {
      liveCalls.delete(evt.callId);
      if (liveCalls.size === 0) {
        const pending = waiters.splice(0, waiters.length);
        for (const done of pending) done();
      }
    }
  });
}

export function lineBusy(): boolean {
  return liveCalls.size > 0;
}

// Resolves once no phone call is in progress. Resolves immediately when the
// line is already free.
function whenLineFree(): Promise<void> {
  if (!lineBusy()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    waiters.push(done);
    setTimeout(() => {
      if (!settled) {
        console.warn(`[line] still busy after ${MAX_WAIT_MS}ms — dialling anyway`);
        done();
      }
    }, MAX_WAIT_MS);
  });
}

// Run `dial` once the line is free and a settling pause has passed. This is the
// only way follow-up calls should be scheduled.
export function dialWhenFree(dial: () => void | Promise<void>, settleMs = SETTLE_MS): void {
  const waiting = lineBusy();
  if (waiting) console.log(`[line] a call is still up — holding the next one`);
  void whenLineFree().then(() => {
    setTimeout(() => void dial(), settleMs);
  });
}
