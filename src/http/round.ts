// -----------------------------------------------------------------------------
// http/round.ts
// Control + read surface for a parallel carrier round.
//   POST /round/start   -> kick off a round against the roster
//   GET  /round         -> current round state (decision + negotiations)
// -----------------------------------------------------------------------------
import { Router } from "express";

import { startRound, peekPendingHumanCarrier } from "../negotiation/round.js";
import { getAllNegotiations, getDecision, getRoundId } from "../store/negotiations.js";
import { config } from "../config.js";

export const roundRoutes = Router();

// Start a round. Body is optional: { carriers?: CarrierSpec[] } to override the
// roster (otherwise data/carriers.json or the built-in demo roster).
roundRoutes.post("/round/start", (req, res) => {
  try {
    const result = startRound({ roster: req.body?.carriers });
    console.log(
      `[round] ${result.roundId.slice(0, 8)} started — ${result.carriers.length} carriers` +
        ` (human via ${result.humanCarrierTransport})`
    );
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

roundRoutes.get("/round", (_req, res) => {
  res.json({
    roundId: getRoundId() ?? null,
    decision: getDecision() ?? null,
    negotiations: getAllNegotiations(),
    humanCarrierTransport: config.humanCarrierTransport,
    waitingForHuman: peekPendingHumanCarrier()?.carrierName ?? null,
  });
});
