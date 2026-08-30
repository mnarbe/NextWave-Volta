// -----------------------------------------------------------------------------
// security/pin.ts
// Proving that the person handing Volta a job is really the client.
//
// They agreed a short code with us beforehand; Volta asks for it before it will
// take anything down. The check lives HERE, in code:
//   - the model never judges whether a code is right. It passes what it heard to
//     verify_caller and is told yes or no. "Only continue if the code is 1234"
//     in a prompt is not a control: it puts the code in the prompt, and a caller
//     can talk the model past it.
//   - set_negotiation_mandate refuses to save while a call is unverified, so
//     skipping the question — by accident, or because someone talked Volta out
//     of it — still cannot produce a mandate.
//
// LIMITS, so nobody mistakes this for real authentication: a short spoken code
// on an unencrypted phone line, with caller ID as the only other signal. It
// stops a wrong number and a casual impostor. It does not stop someone who
// already knows the code, and caller ID can be spoofed. A real deployment wants
// a code per client, rotated, and a callback to a number on file.
// -----------------------------------------------------------------------------
import { timingSafeEqual } from "node:crypto";

import { config } from "../config.js";

// Tries allowed before Volta stops asking.
const MAX_ATTEMPTS = 3;
// Someone who burns their attempts is locked out for this long, keyed by their
// number — otherwise hanging up and redialling hands them a fresh three, and a
// four-digit code falls in an afternoon.
const LOCKOUT_MS = 10 * 60_000;

type Attempts = { failed: number; lockedUntil?: number };

// Keyed by caller number when we have one, by callId otherwise.
const attempts = new Map<string, Attempts>();
const verifiedCalls = new Set<string>();

export function pinRequired(): boolean {
  return config.providerPin.length > 0;
}

export function isVerified(callId: string): boolean {
  if (!pinRequired()) return true;
  return verifiedCalls.has(callId);
}

// Compare without leaking length or position through timing. Overkill on a
// phone line, free, and it keeps the comparison honest if this ever moves
// somewhere that matters.
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

// Speech-to-text writes codes in all sorts of ways: "1234", "1 2 3 4",
// "one two three four". We reduce whatever we heard to digits.
export function normalise(spoken: string): string {
  const words: Record<string, string> = {
    zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  };
  return String(spoken ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((part) => (words[part] !== undefined ? words[part] : part))
    .join("")
    .replace(/\D/g, "");
}

export type PinResult = {
  ok: boolean;
  attemptsLeft: number;
  lockedOut: boolean;
  reason?: string;
};

export function checkPin(opts: {
  callId: string;
  caller?: string;
  entered: string;
}): PinResult {
  if (!pinRequired()) {
    verifiedCalls.add(opts.callId);
    return { ok: true, attemptsLeft: MAX_ATTEMPTS, lockedOut: false };
  }

  const key = opts.caller || opts.callId;
  const state = attempts.get(key) ?? { failed: 0 };

  if (state.lockedUntil && Date.now() < state.lockedUntil) {
    return { ok: false, attemptsLeft: 0, lockedOut: true, reason: "too_many_attempts" };
  }
  // Lockout expired: start clean.
  if (state.lockedUntil && Date.now() >= state.lockedUntil) {
    state.failed = 0;
    state.lockedUntil = undefined;
  }

  const entered = normalise(opts.entered);
  if (entered && sameSecret(entered, config.providerPin)) {
    verifiedCalls.add(opts.callId);
    attempts.delete(key);
    return { ok: true, attemptsLeft: MAX_ATTEMPTS, lockedOut: false };
  }

  state.failed += 1;
  const attemptsLeft = Math.max(0, MAX_ATTEMPTS - state.failed);
  if (attemptsLeft === 0) state.lockedUntil = Date.now() + LOCKOUT_MS;
  attempts.set(key, state);

  return {
    ok: false,
    attemptsLeft,
    lockedOut: attemptsLeft === 0,
    reason: entered ? "wrong_code" : "no_digits_heard",
  };
}

// Keep the code out of the transcript, the dashboard and the call log. While a
// call is unverified, whatever the caller says is very likely the code or a
// near miss, so digits are masked until they are through.
export function redactWhileUnverified(callId: string, text: unknown): string {
  const s = String(text ?? "");
  if (isVerified(callId)) return s;
  return s.replace(/\d/g, "•");
}

export function forgetCall(callId: string): void {
  verifiedCalls.delete(callId);
}

// Test hook: wipe verification and lockouts between cases.
export function resetVerification(): void {
  attempts.clear();
  verifiedCalls.clear();
}
