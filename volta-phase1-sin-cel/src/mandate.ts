// -----------------------------------------------------------------------------
// mandate.ts
// Única autoridad sobre qué se puede aceptar. Los mensajes de "reasons" están
// en INGLÉS a propósito: se le devuelven al modelo como resultado de la tool,
// y queremos que Volta hable inglés de forma consistente.
// -----------------------------------------------------------------------------
import type { Mandate, Proposal, MandateCheck } from "./types.js";

export function checkMandate(mandate: Mandate, proposal: Proposal): MandateCheck {
  const reasons: string[] = [];
  let decision: MandateCheck["decision"] = "allowed";

  // 1) Precio dentro del tope.
  if (proposal.priceMxn > mandate.maxPriceMxn) {
    decision = "rejected";
    reasons.push(
      `Price ${proposal.priceMxn} MXN exceeds the cap of ${mandate.maxPriceMxn} MXN.`
    );
  }

  // 2) Horario dentro de la ventana.
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

  // 3) Condiciones prohibidas.
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
