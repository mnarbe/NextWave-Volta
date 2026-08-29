// -----------------------------------------------------------------------------
// tools.ts
// Dos cosas:
//   1) toolDefinitions: el esquema de las herramientas que le pasamos a la
//      Realtime API para que el modelo sepa qué puede llamar.
//   2) runTool: el despachador que EJECUTA una herramienta cuando el modelo la
//      invoca, y devuelve el resultado que le mandamos de vuelta al modelo.
//
// En Fase 1 tenemos 3 tools: check_mandate, propose_commitment, record_call_note.
// (Fase 2 sumará send_recap / finalize_commitment; Fase 3, compare_quotes / escalate.)
// -----------------------------------------------------------------------------
import { randomUUID } from "node:crypto";
import { getCall, log } from "./store.js";
import { checkMandate } from "./mandate.js";
import type { Proposal } from "./types.js";

// --- 1) Esquema para la Realtime API -----------------------------------------
// Formato de "function tools" que espera la Realtime API: name, description y
// parameters (JSON Schema). El modelo decide cuándo llamarlas.
export const toolDefinitions = [
  {
    type: "function",
    name: "check_mandate",
    description:
      "Valida si una propuesta (precio + hora + condiciones) está dentro del mandato. " +
      "Llamar SIEMPRE antes de aceptar cualquier trato.",
    parameters: {
      type: "object",
      properties: {
        priceMxn: { type: "number", description: "Precio propuesto en MXN." },
        pickupTime: {
          type: "string",
          description: "Hora de recolección propuesta (ISO 8601 si es posible).",
        },
        conditions: {
          type: "array",
          items: { type: "string" },
          description: "Condiciones mencionadas por el transportista.",
        },
      },
      required: ["priceMxn", "pickupTime"],
    },
  },
  {
    type: "function",
    name: "propose_commitment",
    description:
      "Registra un compromiso YA validado por check_mandate. No llamar si check_mandate " +
      "no devolvió 'allowed'.",
    parameters: {
      type: "object",
      properties: {
        priceMxn: { type: "number" },
        pickupTime: { type: "string" },
        conditions: { type: "array", items: { type: "string" } },
        agreedByName: {
          type: "string",
          description: "Nombre del despachador que aceptó, si lo dio.",
        },
      },
      required: ["priceMxn", "pickupTime"],
    },
  },
  {
    type: "function",
    name: "record_call_note",
    description:
      "Deja constancia de algo relevante dicho en la llamada: un precio mencionado, " +
      "un nombre, una objeción, una contradicción.",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "La nota a registrar." },
      },
      required: ["note"],
    },
  },
] as const;

// --- 2) Ejecución -------------------------------------------------------------
// Recibe el nombre de la tool y sus argumentos (ya parseados de JSON), la
// ejecuta contra el estado de la llamada, y devuelve un objeto que se serializa
// y se le manda de vuelta al modelo como resultado de la función.
export async function runTool(
  callId: string,
  name: string,
  args: any
): Promise<Record<string, unknown>> {
  const call = getCall(callId);
  if (!call) return { error: "call_not_found" };

  log(callId, "tool_call", { name, args });

  let result: Record<string, unknown>;

  switch (name) {
    case "check_mandate": {
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
      // Cinturón y tirantes: revalidamos en código aunque el modelo diga que
      // ya lo chequeó. Si no pasa, NO registramos el compromiso.
      const proposal: Proposal = {
        priceMxn: args.priceMxn,
        pickupTime: args.pickupTime,
        conditions: args.conditions || [],
      };
      const check = checkMandate(call.mandate, proposal);
      if (check.decision !== "allowed") {
        result = {
          committed: false,
          decision: check.decision,
          reasons: check.reasons,
        };
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
      // TODO (Fase 2): aquí se dispararía send_recap + timestamp de audio, y el
      // compromiso solo contaría como verificado una vez que el recap salió.
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

  log(callId, "tool_result", { name, result });
  return result;
}
