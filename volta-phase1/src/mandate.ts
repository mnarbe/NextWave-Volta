// -----------------------------------------------------------------------------
// mandate.ts
// El corazón de la seguridad del agente: dada una propuesta del transportista,
// decide si el agente PUEDE aceptarla, debe rechazarla, o debe escalar.
//
// Regla de oro: esta función es la única autoridad sobre el mandato. El modelo
// nunca decide por su cuenta si algo está permitido; siempre pregunta acá.
// -----------------------------------------------------------------------------
import type { Mandate, Proposal, MandateCheck } from "./types.js";

export function checkMandate(mandate: Mandate, proposal: Proposal): MandateCheck {
  const reasons: string[] = [];
  let decision: MandateCheck["decision"] = "allowed";

  // 1) Precio dentro del tope.
  if (proposal.priceMxn > mandate.maxPriceMxn) {
    decision = "rejected";
    reasons.push(
      `Precio ${proposal.priceMxn} MXN supera el tope de ${mandate.maxPriceMxn} MXN.`
    );
  }

  // 2) Horario dentro de la ventana permitida.
  //    Comparamos como fechas si se puede; si no parsea, lo marcamos para escalar
  //    (mejor que aceptar a ciegas).
  const t = Date.parse(proposal.pickupTime);
  const start = Date.parse(mandate.pickupWindowStart);
  const end = Date.parse(mandate.pickupWindowEnd);

  if (Number.isNaN(t) || Number.isNaN(start) || Number.isNaN(end)) {
    decision = decision === "rejected" ? decision : "needs_escalation";
    reasons.push(
      `No pude interpretar el horario ("${proposal.pickupTime}") contra la ventana; requiere revisión humana.`
    );
  } else if (t < start || t > end) {
    decision = "rejected";
    reasons.push(
      `Horario de recolección fuera de la ventana permitida (${mandate.pickupWindowStart} a ${mandate.pickupWindowEnd}).`
    );
  }

  // 3) Condiciones prohibidas. Búsqueda simple por subcadena (Fase 1).
  const forbidden = mandate.forbiddenConditions || [];
  const proposed = proposal.conditions || [];
  for (const cond of proposed) {
    const hit = forbidden.find((f) =>
      cond.toLowerCase().includes(f.toLowerCase())
    );
    if (hit) {
      decision = "rejected";
      reasons.push(`Condición no permitida: "${cond}" (coincide con "${hit}").`);
    }
  }

  if (decision === "allowed") {
    reasons.push("La propuesta está dentro del mandato.");
  }

  return { decision, reasons };
}
