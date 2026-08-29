// -----------------------------------------------------------------------------
// mandate.ts
// Única autoridad sobre qué se puede aceptar. Los mensajes de "reasons" están
// en INGLÉS a propósito: se le devuelven al modelo como resultado de la tool,
// y queremos que Volta hable inglés de forma consistente.
// -----------------------------------------------------------------------------
import type { Mandate, NegotiationMandate, Proposal, MandateCheck } from "./types.js";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Zona horaria.
// Date.parse("2026-09-03T08:00") lo interpreta en la hora LOCAL DEL SERVER,
// pero el modelo suele emitir "2026-09-03T08:00:00Z" (UTC). Con el server en
// México eso corre la ventana 6 horas y rechaza pickups válidos.
// Regla: si el string NO trae zona, lo interpretamos en la zona del mandato.
// ---------------------------------------------------------------------------
const HAS_TZ = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export function parseInMandateTz(value: string): number {
  const raw = (value || "").trim();
  if (!raw) return NaN;
  // "2026-09-03 08:00" -> "2026-09-03T08:00"
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  return Date.parse(HAS_TZ.test(iso) ? iso : `${iso}${config.mandateTzOffset}`);
}

// Ventana "abierta" para cuando el cliente no acotó el horario. Preferimos esto
// a descartar el mandato: el dato crítico es el TOPE DE PRECIO que autorizó el
// cliente, y caer al mandato de respaldo tiraría justamente ese número.
const OPEN_WINDOW_START = "2000-01-01T00:00";
const OPEN_WINDOW_END = "2100-01-01T00:00";

// El intake guarda un NegotiationMandate (casi todo opcional). Para negociar
// hace falta un Mandate completo. Solo devolvemos null si NO hay tope de precio
// utilizable: sin ese número no hay nada que hacer cumplir.
export function toMandate(n: NegotiationMandate | null): Mandate | null {
  if (!n) return null;
  if (!Number.isFinite(n.maxPriceMxn) || n.maxPriceMxn <= 0) return null;
  return {
    origin: n.origin || "(origin not specified)",
    destination: n.destination || "(destination not specified)",
    containerNumber: n.containerNumber,
    maxPriceMxn: n.maxPriceMxn,
    pickupWindowStart: n.pickupWindowStart || OPEN_WINDOW_START,
    pickupWindowEnd: n.pickupWindowEnd || OPEN_WINDOW_END,
    forbiddenConditions: n.forbiddenConditions || [],
  };
}

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
  const t = parseInMandateTz(proposal.pickupTime);
  const start = parseInMandateTz(mandate.pickupWindowStart);
  const end = parseInMandateTz(mandate.pickupWindowEnd);

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

// -----------------------------------------------------------------------------
// Mandato de respaldo para la fase de negociación cuando todavía no hay uno
// capturado del cliente (o el capturado está incompleto). Explícito a propósito:
// preferimos un fallback visible a negociar con datos a medias.
// -----------------------------------------------------------------------------
export const DEFAULT_MANDATE: Mandate = {
  origin: "Port of Manzanillo",
  destination: "Warehouse in Guadalajara",
  containerNumber: "MSCU1234567",
  maxPriceMxn: 9000,
  pickupWindowStart: "2026-09-03T08:00",
  pickupWindowEnd: "2026-09-03T18:00",
  forbiddenConditions: ["prepayment", "no insurance"],
};

// El mandato que hay que usar para negociar: el del cliente si está completo,
// si no el de respaldo. Devuelve también de dónde salió, para poder mostrarlo.
export function negotiationMandate(captured: NegotiationMandate | null): {
  mandate: Mandate;
  source: "captured" | "default";
} {
  const fromClient = toMandate(captured);
  return fromClient
    ? { mandate: fromClient, source: "captured" }
    : { mandate: DEFAULT_MANDATE, source: "default" };
}
