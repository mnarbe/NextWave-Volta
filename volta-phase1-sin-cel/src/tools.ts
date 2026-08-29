// -----------------------------------------------------------------------------
// tools.ts
// Las 3 tools de Fase 1 y su ejecución. Idéntico a la versión con teléfono:
// el transporte de audio cambió, la lógica de negocio no.
// -----------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import { getCall, log } from "./store.js";
import { checkMandate } from "./mandate.js";
import { saveMandate } from "./mandateStore.js";
import {
  recordOffer,
  recordRefusal,
  finalizeNegotiation,
  resetNegotiations,
} from "./negotiationStore.js";
import type { Mandate, NegotiationMandate, Proposal } from "./types.js";

// Cuántos días tarde llega el pickup respecto de la ventana pedida por el
// cliente. 0 = dentro de la ventana. undefined = no hay ventana firme o no se
// pudo parsear. Lo calculamos en código para no depender del modelo.
function computeDelayDays(
  mandate: Mandate | null,
  pickupTime?: string
): number | undefined {
  if (!mandate || !pickupTime || !mandate.pickupWindowEnd) return undefined;
  const endYear = Number(mandate.pickupWindowEnd.slice(0, 4));
  if (!Number.isFinite(endYear) || endYear >= 2100) return undefined; // ventana "abierta"
  const t = Date.parse(pickupTime);
  const end = Date.parse(mandate.pickupWindowEnd);
  if (Number.isNaN(t) || Number.isNaN(end)) return undefined;
  const diff = t - end;
  if (diff <= 0) return 0;
  return Math.ceil(diff / 86_400_000);
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}

// ---------------------------------------------------------------------------
// FASE 0 — tools del INTAKE con el jurado.
// ---------------------------------------------------------------------------
export const intakeToolDefinitions = [
  {
    type: "function",
    name: "set_negotiation_mandate",
    description:
      "Save the brief captured from the client so it can be used later to " +
      "negotiate with carriers. Call this ONCE you have a firm maximum price. " +
      "maxPriceMxn is the only required field; fill the rest best-effort.",
    parameters: {
      type: "object",
      properties: {
        maxPriceMxn: {
          type: "number",
          description: "Maximum price the client authorizes, in MXN (plain number).",
        },
        origin: { type: "string" },
        destination: { type: "string" },
        containerNumber: { type: "string" },
        pickupWindowStart: {
          type: "string",
          description: "Earliest allowed pickup, ISO 8601 (e.g. 2026-09-03T08:00).",
        },
        pickupWindowEnd: {
          type: "string",
          description: "Latest allowed pickup, ISO 8601.",
        },
        forbiddenConditions: {
          type: "array",
          items: { type: "string" },
          description: "Conditions the client refuses (e.g. prepayment, no insurance).",
        },
        notes: {
          type: "string",
          description: "Anything else relevant for the negotiation.",
        },
      },
      required: ["maxPriceMxn"],
    },
  },
  {
    type: "function",
    name: "record_call_note",
    description:
      "Log something relevant said during the call: a name, context, a special " +
      "requirement, an objection.",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "The note to record." },
      },
      required: ["note"],
    },
  },
  {
    type: "function",
    name: "end_intake",
    description:
      "End the call with the client. Call this only AFTER set_negotiation_mandate " +
      "succeeded and you have said your closing line.",
    parameters: { type: "object", properties: {} },
  },
] as const;

// Esquema para la Realtime API.
export const toolDefinitions = [
  {
    type: "function",
    name: "check_mandate",
    description:
      "Validate whether a proposal (price + time + conditions) is within the mandate. " +
      "ALWAYS call this before agreeing to any deal.",
    parameters: {
      type: "object",
      properties: {
        priceMxn: { type: "number", description: "Proposed price in MXN." },
        pickupTime: {
          type: "string",
          description: "Proposed pickup time (ISO 8601 if possible).",
        },
        conditions: {
          type: "array",
          items: { type: "string" },
          description: "Conditions mentioned by the carrier.",
        },
      },
      required: ["priceMxn", "pickupTime"],
    },
  },
  {
    type: "function",
    name: "propose_commitment",
    description:
      "Record a commitment ALREADY validated by check_mandate. Do not call if " +
      "check_mandate did not return 'allowed'.",
    parameters: {
      type: "object",
      properties: {
        priceMxn: { type: "number" },
        pickupTime: { type: "string" },
        conditions: { type: "array", items: { type: "string" } },
        agreedByName: {
          type: "string",
          description: "Name of the dispatcher who agreed, if given.",
        },
      },
      required: ["priceMxn", "pickupTime"],
    },
  },
  {
    type: "function",
    name: "record_call_note",
    description:
      "Log something relevant said during the call: a price mentioned, a name, " +
      "an objection, a contradiction.",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "The note to record." },
      },
      required: ["note"],
    },
  },
  {
    type: "function",
    name: "log_carrier_offer",
    description:
      "Record what the carrier is offering or demanding, for the client dashboard. " +
      "Call this EVERY time the carrier names or changes their price, gives a " +
      "pickup date/time, says the earliest they can do is later than the " +
      "requested window (a DELAY), or attaches any condition or caveat " +
      "(prepayment, deposit, advance notice, detention/waiting fees, liftgate or " +
      "extra-handling surcharge, insurance limits, no weekend pickups, etc.). " +
      "It is fine to call it several times as the picture fills in; pass whatever " +
      "you have this turn.",
    parameters: {
      type: "object",
      properties: {
        carrierName: {
          type: "string",
          description: "Carrier / dispatcher / company name, once you know it.",
        },
        priceMxn: { type: "number", description: "Price the carrier is quoting, in MXN." },
        pickupTime: {
          type: "string",
          description: "Pickup date/time the carrier offered (ISO 8601 if possible).",
        },
        delayNote: {
          type: "string",
          description:
            "Any timing deviation vs the client's requested window, in the " +
            "carrier's words (e.g. 'earliest is Friday, driver shortage').",
        },
        conditions: {
          type: "array",
          items: { type: "string" },
          description:
            "Conditions / surcharges / caveats the carrier attaches. One short " +
            "phrase each (e.g. '30% prepayment', '48h advance notice', " +
            "'MXN 500 detention fee after 2h').",
        },
        note: { type: "string", description: "Anything else worth recording." },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "note_carrier_refusal",
    description:
      "Call this EVERY time the carrier refuses to lower their price after you " +
      "asked them to come down (they hold firm or repeat the same number). " +
      "Returns how many refusals so far and whether you should now close the call.",
    parameters: {
      type: "object",
      properties: {
        priceMxn: {
          type: "number",
          description: "The price the carrier is holding at, in MXN.",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "end_negotiation",
    description:
      "End the call with the carrier politely. Call this after you've closed a " +
      "deal, or after the carrier refused to lower their price twice, or if " +
      "their best price is over your cap. Pass the final picture so it lands on " +
      "the client dashboard.",
    parameters: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["deal", "no_deal"],
          description: "Whether a commitment was reached.",
        },
        finalPriceMxn: {
          type: "number",
          description: "The price the call ended on, in MXN (agreed, or their last stance).",
        },
        finalPickupTime: {
          type: "string",
          description: "The pickup date/time the call ended on (ISO 8601 if possible).",
        },
        delayNote: {
          type: "string",
          description: "Timing deviation vs the client's requested window, if any.",
        },
        conditionsToRelay: {
          type: "array",
          items: { type: "string" },
          description:
            "Carrier conditions / surcharges / caveats the client needs to be " +
            "told about. One short phrase each.",
        },
        summary: {
          type: "string",
          description: "One line: how it ended and why.",
        },
      },
      required: [],
    },
  },
] as const;

export async function runTool(
  callId: string,
  name: string,
  args: any
): Promise<Record<string, unknown>> {
  const call = getCall(callId);
  if (!call) return { error: "call_not_found" };

  let result: Record<string, unknown>;

  switch (name) {
    // --- FASE 0: intake con el jurado -------------------------------------
    case "set_negotiation_mandate": {
      const max = Number(args.maxPriceMxn);
      if (!Number.isFinite(max) || max <= 0) {
        result = { saved: false, error: "maxPriceMxn must be a positive number of MXN." };
        break;
      }
      const mandate: NegotiationMandate = {
        maxPriceMxn: Math.round(max),
        currency: "MXN",
        origin: args.origin || undefined,
        destination: args.destination || undefined,
        containerNumber: args.containerNumber || undefined,
        pickupWindowStart: args.pickupWindowStart || undefined,
        pickupWindowEnd: args.pickupWindowEnd || undefined,
        forbiddenConditions: Array.isArray(args.forbiddenConditions)
          ? args.forbiddenConditions
          : undefined,
        notes: args.notes || undefined,
        capturedAt: new Date().toISOString(),
      };
      saveMandate(mandate);
      // Trabajo nuevo: limpiamos las negociaciones con carriers de la corrida anterior.
      resetNegotiations();
      result = { saved: true, mandate };
      break;
    }

    case "end_intake": {
      result = { ok: true, ending: true };
      break;
    }

    // --- FASE 1: negociación con el carrier -------------------------------
    case "log_carrier_offer": {
      const pickupTime = args.pickupTime || undefined;
      const carrier = recordOffer(callId, args.carrierName, {
        ts: new Date().toISOString(),
        priceMxn: num(args.priceMxn),
        pickupTime,
        pickupDelayDays: computeDelayDays(call.mandate, pickupTime),
        delayNote: args.delayNote || undefined,
        conditions: strArray(args.conditions),
        note: args.note || undefined,
      });
      result = { ok: true, carrier };
      break;
    }

    case "note_carrier_refusal": {
      call.refusals += 1;
      recordRefusal(callId, call.refusals);
      result = {
        refusals: call.refusals,
        shouldClose: call.refusals >= 2,
        holdingPriceMxn: Number.isFinite(Number(args.priceMxn))
          ? Math.round(Number(args.priceMxn))
          : undefined,
      };
      break;
    }

    case "end_negotiation": {
      const outcome = args.outcome === "deal" ? "deal" : "no_deal";
      const finalPickupTime = args.finalPickupTime || undefined;
      const carrier = finalizeNegotiation(callId, {
        outcome,
        finalPriceMxn: num(args.finalPriceMxn),
        finalPickupTime,
        pickupDelayDays: computeDelayDays(call.mandate, finalPickupTime),
        delayNote: args.delayNote || undefined,
        conditionsToRelay: strArray(args.conditionsToRelay),
        summary: args.summary || undefined,
        mandate: call.mandate,
      });
      result = { ok: true, ending: true, outcome, carrier };
      break;
    }

    case "check_mandate": {
      if (!call.mandate) {
        result = { error: "no_mandate_loaded" };
        break;
      }
      const proposal: Proposal = {
        priceMxn: args.priceMxn,
        pickupTime: args.pickupTime,
        conditions: args.conditions || [],
      };
      const check = checkMandate(call.mandate, proposal);
      result = { decision: check.decision, reasons: check.reasons };
      break;
    }

    case "propose_commitment": {
      if (!call.mandate) {
        result = { error: "no_mandate_loaded" };
        break;
      }
      // Revalidamos en código aunque el modelo diga que ya lo chequeó.
      const proposal: Proposal = {
        priceMxn: args.priceMxn,
        pickupTime: args.pickupTime,
        conditions: args.conditions || [],
      };
      const check = checkMandate(call.mandate, proposal);
      if (check.decision !== "allowed") {
        result = { committed: false, decision: check.decision, reasons: check.reasons };
        break;
      }
      const commitment = {
        id: randomUUID(),
        callId,
        priceMxn: proposal.priceMxn,
        pickupTime: proposal.pickupTime,
        conditions: proposal.conditions || [],
        agreedByName: args.agreedByName,
        createdAt: new Date().toISOString(),
      };
      call.commitments.push(commitment);
      // Reflejamos el compromiso en el registro de negociación (dashboard).
      recordOffer(callId, args.agreedByName, {
        ts: commitment.createdAt,
        priceMxn: commitment.priceMxn,
        pickupTime: commitment.pickupTime,
        pickupDelayDays: computeDelayDays(call.mandate, commitment.pickupTime),
        conditions: commitment.conditions,
        note: "compromiso validado por check_mandate",
      });
      // TODO (Fase 2): send_recap + timestamp de audio antes de contar como verificado.
      result = { committed: true, commitmentId: commitment.id };
      break;
    }

    case "record_call_note": {
      log(callId, "tool_result", { note: args.note });
      result = { ok: true };
      break;
    }

    default:
      result = { error: `unknown_tool_${name}` };
  }

  return result;
}
