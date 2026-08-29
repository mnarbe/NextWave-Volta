// -----------------------------------------------------------------------------
// domain/mandate.ts
// The single authority on what may be accepted. The "reasons" messages are in
// English on purpose: they are handed back to the model as the tool result, and
// we want Volta to speak English consistently.
// -----------------------------------------------------------------------------
import type {
  Mandate,
  NegotiationMandate,
  Proposal,
  MandateCheck,
} from "./types.js";
import { OPEN_WINDOW_START, OPEN_WINDOW_END, OPEN_WINDOW_YEAR } from "./defaults.js";

export function checkMandate(mandate: Mandate, proposal: Proposal): MandateCheck {
  const reasons: string[] = [];
  let decision: MandateCheck["decision"] = "allowed";

  // 1) Price within the cap.
  if (proposal.priceMxn > mandate.maxPriceMxn) {
    decision = "rejected";
    reasons.push(
      `Price ${proposal.priceMxn} MXN exceeds the cap of ${mandate.maxPriceMxn} MXN.`
    );
  }

  // 2) Pickup time inside the window.
  const t = Date.parse(proposal.pickupTime);
  const start = Date.parse(mandate.pickupWindowStart);
  const end = Date.parse(mandate.pickupWindowEnd);

  if (Number.isNaN(t) || Number.isNaN(start) || Number.isNaN(end)) {
    decision = decision === "rejected" ? decision : "needs_escalation";
    reasons.push(
      `Could not parse the pickup time ("${proposal.pickupTime}") against the window; needs human review.`
    );
  } else if (t < start || t > end) {
    decision = "rejected";
    reasons.push(
      `Pickup time is outside the allowed window (${mandate.pickupWindowStart} to ${mandate.pickupWindowEnd}).`
    );
  }

  // 3) Forbidden conditions.
  const forbidden = mandate.forbiddenConditions || [];
  const proposed = proposal.conditions || [];
  for (const cond of proposed) {
    const hit = forbidden.find((f) => cond.toLowerCase().includes(f.toLowerCase()));
    if (hit) {
      decision = "rejected";
      reasons.push(`Forbidden condition: "${cond}" (matches "${hit}").`);
    }
  }

  if (decision === "allowed") reasons.push("The proposal is within the mandate.");

  return { decision, reasons };
}

// The mandate captured from the client (NegotiationMandate) -> the shape the
// negotiation phase uses (Mandate), filling in whatever is missing.
export function toMandate(m: NegotiationMandate): Mandate {
  return {
    origin: m.origin || "(origin not specified)",
    destination: m.destination || "(destination not specified)",
    containerNumber: m.containerNumber,
    maxPriceMxn: m.maxPriceMxn,
    pickupWindowStart: m.pickupWindowStart || OPEN_WINDOW_START,
    pickupWindowEnd: m.pickupWindowEnd || OPEN_WINDOW_END,
    forbiddenConditions: m.forbiddenConditions || [],
  };
}

// How many days late the pickup lands relative to the window the client asked
// for. 0 = inside the window. undefined = no firm window, or unparseable. We
// compute it in code so we don't depend on the model.
export function computeDelayDays(
  mandate: Mandate | null,
  pickupTime?: string
): number | undefined {
  if (!mandate || !pickupTime || !mandate.pickupWindowEnd) return undefined;
  const endYear = Number(mandate.pickupWindowEnd.slice(0, 4));
  if (!Number.isFinite(endYear) || endYear >= OPEN_WINDOW_YEAR) return undefined;
  const t = Date.parse(pickupTime);
  const end = Date.parse(mandate.pickupWindowEnd);
  if (Number.isNaN(t) || Number.isNaN(end)) return undefined;
  const diff = t - end;
  if (diff <= 0) return 0;
  return Math.ceil(diff / 86_400_000);
}
