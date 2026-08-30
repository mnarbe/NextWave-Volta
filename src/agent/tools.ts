// -----------------------------------------------------------------------------
// agent/tools.ts
// The tool definitions and their execution. Same as the phone version: the audio
// transport changed, the business logic did not.
// -----------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import { getCall, log } from "../store/calls.js";
import { checkMandate, computeDelayDays } from "../domain/mandate.js";
import { saveMandate } from "../store/mandates.js";
import {
  recordOffer,
  recordRefusal,
  finalizeNegotiation,
  getNegotiation,
  resetNegotiations,
} from "../store/negotiations.js";
import { evaluateChange, resolveChange } from "../negotiation/escalation.js";
import type { NegotiationMandate, Proposal } from "../domain/types.js";

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// What the brief still needs before Volta can go negotiate. The client may
// genuinely not know the container number, so that one is asked for but never
// required.
function missingMandateFields(m: NegotiationMandate): string[] {
  const missing: string[] = [];
  if (!m.origin) missing.push("origin");
  if (!m.destination) missing.push("destination");
  if (!m.pickupWindowStart) missing.push("pickupWindowStart");
  if (!m.pickupWindowEnd) missing.push("pickupWindowEnd");
  return missing;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}

// ---------------------------------------------------------------------------
// PHASE 0 — INTAKE tools (talking to the client).
// ---------------------------------------------------------------------------
export const intakeToolDefinitions = [
  {
    type: "function",
    name: "set_negotiation_mandate",
    description:
      "Save the brief captured from the client so it can be used later to " +
      "negotiate with carriers. Call this as soon as you have a firm maximum " +
      "price, and again every time you fill in another field. The result lists " +
      "which required fields are still missing, so you know what to ask next.",
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

// ---------------------------------------------------------------------------
// ESCALATION tools — Volta calls the PROVIDER because a booked carrier changed
// something it is not authorised to accept. The only outcome that matters is
// the provider's yes or no.
// ---------------------------------------------------------------------------
export const escalationToolDefinitions = [
  {
    type: "function",
    name: "record_provider_decision",
    description:
      "Record the client's answer to the carrier's change. Call this as soon as " +
      "they have clearly said yes or no — do not guess, and do not call it while " +
      "they are still thinking out loud.",
    parameters: {
      type: "object",
      properties: {
        approved: {
          type: "boolean",
          description: "True if the client accepts the carrier's change.",
        },
        note: {
          type: "string",
          description: "Anything they said about why, or a condition they attached.",
        },
      },
      required: ["approved"],
    },
  },
  {
    type: "function",
    name: "record_call_note",
    description: "Log something relevant the client said.",
    parameters: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
    },
  },
  {
    type: "function",
    name: "end_escalation",
    description:
      "End the call with the client. Call this only AFTER record_provider_decision " +
      "and after you have said your closing line.",
    parameters: { type: "object", properties: {} },
  },
] as const;

// PHASE 1 — carrier negotiation tools. Schema for the Realtime API.
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
    name: "request_change",
    description:
      "Call this when a carrier you have ALREADY BOOKED tells you something has " +
      "changed: a different price, a pickup that moves, a new condition, or that " +
      "they cannot do the job at all (truck broken, cannot reach the destination). " +
      "Pass only what changed. The result tells you whether the change still fits " +
      "what the client authorised — if it does, you accept it yourself; if it does " +
      "not, you must tell the carrier you need to check with the client and end the " +
      "call. Do NOT decide that yourself.",
    parameters: {
      type: "object",
      properties: {
        priceMxn: { type: "number", description: "The NEW price they are asking, in MXN." },
        pickupTime: { type: "string", description: "The NEW pickup date/time (ISO 8601)." },
        conditions: {
          type: "array",
          items: { type: "string" },
          description: "New conditions or surcharges they are attaching.",
        },
        cannotDo: {
          type: "boolean",
          description:
            "True if they cannot do the job at all — broken truck, cannot reach " +
            "the destination, no driver.",
        },
        note: { type: "string", description: "What they said, in one line." },
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
    // --- PHASE 0: intake with the client ----------------------------------
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
      // New job: clear the carrier negotiations from the previous run.
      resetNegotiations();
      // Tell Volta what the brief is still missing, so it knows what to ask
      // next instead of closing the call half-informed. containerNumber is not
      // in here: we ask for it once, but the client may simply not have it.
      const missing = missingMandateFields(mandate);
      result = { saved: true, mandate, missing, complete: missing.length === 0 };
      break;
    }

    case "end_intake": {
      result = { ok: true, ending: true };
      break;
    }

    // --- PHASE 1: negotiation with the carrier ----------------------------
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

    // A booked carrier is changing the deal. Whether Volta can wave it through
    // or has to ask the client is decided in code (negotiation/escalation.ts),
    // never by the model.
    case "request_change": {
      const change = evaluateChange({
        mandate: call.mandate,
        carrierId: getNegotiation(callId)?.carrierId,
        carrierName: getNegotiation(callId)?.carrierName,
        requested: {
          priceMxn: num(args.priceMxn),
          pickupTime: args.pickupTime || undefined,
          conditions: strArray(args.conditions),
          cannotDo: args.cannotDo === true,
          note: args.note || undefined,
        },
      });

      result = {
        withinMandate: change.withinMandate,
        decision: change.withinMandate ? "accept_yourself" : "must_ask_the_client",
        reasons: change.reasons,
        agreed: change.agreed,
        instruction: change.withinMandate
          ? "This still fits what the client authorised. Accept it on this call, " +
            "confirm the new terms out loud, and close normally."
          : "You CANNOT accept this. Tell the carrier you need to check with the " +
            "client who ordered the truck, that you will call them back shortly, " +
            "thank them and end the call with end_negotiation.",
      };
      break;
    }

    // The provider answered an escalation: yes or no to the carrier's change.
    case "record_provider_decision": {
      const approved = args.approved === true;
      const resolved = resolveChange(approved, args.note || undefined);
      if (!resolved) {
        result = { error: "no_pending_change" };
        break;
      }
      result = {
        ok: true,
        ending: true,
        approved,
        carrierName: resolved.carrierName,
        instruction: approved
          ? "Tell the client you'll confirm it with the carrier now, thank them, " +
            "and call end_escalation."
          : "Tell the client you'll cancel with the carrier and come back with " +
            "other options, thank them, and call end_escalation.",
      };
      break;
    }

    case "end_escalation": {
      result = { ok: true, ending: true };
      break;
    }

    case "end_negotiation": {
      const finalPickupTime = args.finalPickupTime || undefined;
      const finalPrice = num(args.finalPriceMxn);

      // In a ROUND, "outcome" means "is this quote usable?", and that is a
      // question about the price, not a judgement call. The model reliably
      // negotiates the price down but then marks a perfectly good quote as
      // "no_deal" because it did not book it on the call — which silently drops
      // that carrier from the comparison. So we decide it here.
      const cap = call.mandate?.maxPriceMxn;
      const inRound = Boolean(getNegotiation(callId)?.roundId);
      const modelOutcome = args.outcome === "deal" ? "deal" : "no_deal";
      const outcome: "deal" | "no_deal" =
        inRound && finalPrice != null && cap != null
          ? finalPrice <= cap
            ? "deal"
            : "no_deal"
          : modelOutcome;

      if (outcome !== modelOutcome) {
        log(callId, "tool_result", {
          name: "end_negotiation",
          note: `outcome corrected ${modelOutcome} -> ${outcome} (${finalPrice} vs cap ${cap})`,
        });
      }

      const carrier = finalizeNegotiation(callId, {
        outcome,
        finalPriceMxn: finalPrice,
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
      // Re-validate in code even if the model claims it already checked.
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
      // Mirror the commitment into the negotiation record (dashboard).
      recordOffer(callId, args.agreedByName, {
        ts: commitment.createdAt,
        priceMxn: commitment.priceMxn,
        pickupTime: commitment.pickupTime,
        pickupDelayDays: computeDelayDays(call.mandate, commitment.pickupTime),
        conditions: commitment.conditions,
        note: "commitment validated by check_mandate",
      });
      // TODO (Phase 2): send_recap + audio timestamp before counting as verified.
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
