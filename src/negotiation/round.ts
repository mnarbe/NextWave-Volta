// -----------------------------------------------------------------------------
// negotiation/round.ts
// A ROUND: negotiate the current mandate against every carrier on the roster at
// the same time, then pick the winner (domain/compare.ts).
//
//   - "sim" carriers start negotiating immediately, in the background.
//   - the ONE "human" carrier gets a placeholder record right away; the real
//     session attaches to it when the person connects (browser mic or phone),
//     claiming it via claimPendingHumanCarrier().
//
// The round closes when every carrier has a final result (or on a timeout), and
// publishes a "round_done" event with the RoundDecision.
// -----------------------------------------------------------------------------
import { randomUUID } from "node:crypto";

import { config } from "../config.js";
import { publish, subscribe } from "../bus.js";
import { createCall } from "../store/calls.js";
import { getMandate } from "../store/mandates.js";
import {
  beginNegotiation,
  finalizeRound,
  getNegotiation,
  resetNegotiations,
  setRound,
} from "../store/negotiations.js";
import { toMandate } from "../domain/mandate.js";
import type { CarrierSpec } from "../domain/types.js";
import { loadRoster } from "./roster.js";
import { clearChanges } from "./escalation.js";
import { runTextNegotiation } from "./text-run.js";

// The human might take a few minutes; the sims finish in well under one. If a
// carrier never closes, the round finalizes anyway with whatever it has.
const ROUND_TIMEOUT_MS = 6 * 60_000;

// The one human carrier seat waiting to be filled by an incoming session.
export type PendingHuman = {
  roundId: string;
  carrierId: string;
  carrierName: string;
  callId: string;
};
let pendingHuman: PendingHuman | null = null;

// Called by the browser / phone transports when a negotiate session starts:
// hands over (and clears) the human carrier seat for the active round.
export function claimPendingHumanCarrier(): PendingHuman | null {
  const p = pendingHuman;
  pendingHuman = null;
  return p;
}

export function peekPendingHumanCarrier(): PendingHuman | null {
  return pendingHuman;
}

export type StartRoundResult = {
  roundId: string;
  carriers: CarrierSpec[];
  humanCarrierTransport: "browser" | "phone";
};

export function startRound(opts: { roster?: unknown } = {}): StartRoundResult {
  const raw = getMandate();
  if (!raw) throw new Error("No mandate captured yet — run intake first.");
  const mandate = toMandate(raw);

  const roster = loadRoster(opts.roster);
  const humans = roster.filter((c) => c.kind === "human");
  if (humans.length > 1) throw new Error("Roster has more than one human carrier.");
  if (!roster.some((c) => c.kind === "sim")) {
    throw new Error("Roster has no scripted carriers.");
  }

  const roundId = randomUUID();
  resetNegotiations();
  // A round is a fresh comparison: any half-finished change from the last one
  // refers to a booking this round is about to replace.
  clearChanges();
  setRound(roundId);

  const pending = new Set(roster.map((c) => c.id));
  let finished = false;

  const unsubscribe = subscribe((evt) => {
    if (evt.kind !== "negotiation_done") return;
    const neg = getNegotiation(evt.callId);
    if (!neg || neg.roundId !== roundId || !neg.carrierId) return;
    if (pending.delete(neg.carrierId) && pending.size === 0) finish();
  });

  const timer = setTimeout(finish, ROUND_TIMEOUT_MS);

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    unsubscribe();
    if (pendingHuman?.roundId === roundId) pendingHuman = null;
    const decision = finalizeRound(mandate);
    publish({ kind: "round_done", callId: roundId, transport: "sim", data: decision });
  }

  for (const carrier of roster) {
    const callId = `${roundId}:${carrier.id}`;
    createCall(mandate, callId);
    beginNegotiation(callId, mandate, {
      carrierId: carrier.id,
      carrierName: carrier.name,
      kind: carrier.kind,
      roundId,
    });

    if (carrier.kind === "sim") {
      publish({ kind: "call_started", callId, transport: "sim", data: { carrier } });
      void runTextNegotiation({ callId, mandate, carrier }).catch((err) => {
        publish({
          kind: "error",
          callId,
          transport: "sim",
          data: { where: "round", err: String(err) },
        });
      });
    } else {
      pendingHuman = {
        roundId,
        carrierId: carrier.id,
        carrierName: carrier.name,
        callId,
      };
      publish({
        kind: "call_started",
        callId,
        transport: config.humanCarrierTransport,
        data: { carrier, waiting: true },
      });
    }
  }

  // No human on the roster -> nothing else will complete; the sims will trip
  // finish() on their own.
  return { roundId, carriers: roster, humanCarrierTransport: config.humanCarrierTransport };
}
