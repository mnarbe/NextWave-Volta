// -----------------------------------------------------------------------------
// tools.ts
// Las 3 tools de Fase 1 y su ejecución. Idéntico a la versión con teléfono:
// el transporte de audio cambió, la lógica de negocio no.
// -----------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import { getCall, log } from "./store.js";
import { checkMandate } from "./mandate.js";
import { saveMandate } from "./mandateStore.js";
import type { NegotiationMandate, Proposal } from "./types.js";

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
      result = { saved: true, mandate };
      break;
    }

    case "end_intake": {
      result = { ok: true, ending: true };
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
