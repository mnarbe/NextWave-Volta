// -----------------------------------------------------------------------------
// domain/compare.ts
// Pick the winning carrier out of a finished round.
//
// A carrier can WIN automatically only if its closed deal is clean:
//   - outcome "deal",
//   - final price at or below the mandate cap,
//   - pickup INSIDE the client's window (no delay), and
//   - no forbidden condition attached.
// Among those, the lowest price wins (tie-break: fewer conditions, earlier start).
//
// Deals that closed but fail one of those checks are not discarded — they go to
// needsHumanReview so a person can decide. If nothing is eligible, the round
// outcome is "no_deal".
// -----------------------------------------------------------------------------
import type {
  CarrierNegotiation,
  Mandate,
  RankedCarrier,
  RoundComparison,
} from "./types.js";

function forbiddenHits(conditions: string[], forbidden: string[]): string[] {
  const hits: string[] = [];
  for (const cond of conditions) {
    const hit = forbidden.find((f) => cond.toLowerCase().includes(f.toLowerCase()));
    if (hit) hits.push(cond);
  }
  return hits;
}

function assess(c: CarrierNegotiation, mandate: Mandate | null): RankedCarrier {
  const f = c.final;
  const delay = f?.pickupDelayDays ?? c.latest.pickupDelayDays ?? 0;
  const conditions = f?.conditionsToRelay ?? c.latest.conditions ?? [];
  const disq: string[] = [];

  if (!f || f.outcome !== "deal") {
    disq.push("no deal closed");
  } else {
    if (f.priceMxn == null) {
      disq.push("no final price");
    } else if (mandate && f.priceMxn > mandate.maxPriceMxn) {
      disq.push(`price ${f.priceMxn} MXN over cap ${mandate.maxPriceMxn} MXN`);
    }
    if (delay > 0) disq.push(`pickup ${delay} day${delay === 1 ? "" : "s"} past the window`);
    const forbidden = mandate?.forbiddenConditions ?? [];
    for (const bad of forbiddenHits(conditions, forbidden)) {
      disq.push(`forbidden condition: "${bad}"`);
    }
  }

  return {
    callId: c.callId,
    carrierId: c.carrierId,
    carrierName: c.carrierName || "(unnamed carrier)",
    kind: c.kind,
    eligible: disq.length === 0,
    outcome: f?.outcome,
    priceMxn: f?.priceMxn ?? c.latest.priceMxn,
    pickupDelayDays: delay,
    conditionCount: conditions.length,
    disqualifiers: disq,
  };
}

export function compareCarriers(
  carriers: CarrierNegotiation[],
  mandate: Mandate | null
): RoundComparison {
  const assessed = carriers.map((c) => assess(c, mandate));

  const eligible = assessed
    .filter((r) => r.eligible)
    .sort(
      (a, b) =>
        (a.priceMxn ?? Infinity) - (b.priceMxn ?? Infinity) ||
        a.pickupDelayDays - b.pickupDelayDays ||
        a.conditionCount - b.conditionCount ||
        a.carrierName.localeCompare(b.carrierName)
    );
  const rest = assessed.filter((r) => !r.eligible);
  const ranking = [...eligible, ...rest];

  const winner = eligible[0];
  const needsHumanReview = rest
    .filter((r) => r.outcome === "deal")
    .map((r) => ({
      callId: r.callId,
      carrierName: r.carrierName,
      why: r.disqualifiers.join("; "),
    }));

  let reason: string;
  if (winner) {
    reason =
      `${winner.carrierName} wins at ${winner.priceMxn} MXN` +
      (eligible.length > 1 ? ` (lowest of ${eligible.length} clean offers).` : " (only clean offer).");
  } else if (needsHumanReview.length) {
    reason =
      `${needsHumanReview.length} deal(s) closed but none met price + on-time pickup + terms. ` +
      `Needs human review.`;
  } else {
    reason = "No carrier closed a deal within the mandate.";
  }

  return {
    outcome: winner ? "deal" : "no_deal",
    winnerCallId: winner?.callId,
    ranking,
    needsHumanReview,
    reason,
  };
}
