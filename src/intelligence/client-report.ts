// -----------------------------------------------------------------------------
// client-report.ts
//
// Builds the factual snapshot Volta may read to a client after a round. This is
// deliberately downstream of the comparator: it explains a decision already
// made and has no path back into carrier ranking or negotiation strategy.
// -----------------------------------------------------------------------------
import { getDecision, getNegotiation } from "../store/negotiations.js";
import { listCarrierProfiles, type CarrierProfile } from "./carrier-profiles.js";

export type ClientCarrierReport = {
  carrierName: string;
  currentPriceMxn?: number;
  profile?: CarrierProfile;
};

export function currentClientCarrierReport(): ClientCarrierReport | null {
  const decision = getDecision();
  if (!decision || decision.outcome !== "deal" || !decision.winnerCallId) return null;

  const winner = getNegotiation(decision.winnerCallId);
  if (!winner) return null;

  return {
    carrierName: winner.carrierName || "the selected carrier",
    currentPriceMxn: winner.final?.priceMxn ?? winner.latest.priceMxn,
    profile: listCarrierProfiles().find((profile) => profile.carrierId === winner.carrierId),
  };
}
