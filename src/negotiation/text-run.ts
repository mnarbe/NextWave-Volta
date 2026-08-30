// -----------------------------------------------------------------------------
// negotiation/text-run.ts
// Runs ONE negotiation between Volta and a scripted carrier, entirely in text
// (no audio). Volta is the same brain as the voice agent — same prompt
// (agent/prompts.ts), same tools (agent/tools.ts), same runTool — just driven
// over Chat Completions instead of the Realtime socket.
//
// It emits the SAME bus events as the voice bridge (tool_call, tool_result,
// carrier_offer, carrier_refusal, negotiation_done, *_transcript), so the
// dashboard and the Firestore mirror work with no changes.
// -----------------------------------------------------------------------------
import { buildInstructions } from "../agent/prompts.js";
import { toolDefinitions, runTool } from "../agent/tools.js";
import { log } from "../store/calls.js";
import { finalizeNegotiation } from "../store/negotiations.js";
import { publish } from "../bus.js";
import type { CarrierSpec, Mandate } from "../domain/types.js";
import { chat, wrapTools, type ChatMessage } from "./openai.js";
import { SimCarrier } from "./sim-carrier.js";

// Hard stop so a rambling negotiation can never spin forever.
const MAX_STEPS = 30;

const TEXT_PREAMBLE = `
This negotiation is happening over a text channel, not voice. Keep every turn to
1-3 short sentences. The carrier's dispatcher speaks as the user. Move briskly:
greet, state the job, get their price, make your counters, and close without
stalling. If the carrier's standing price is at or below your ceiling, CLOSE THE
DEAL — run the closing check and end_negotiation with outcome "deal". Do not walk
away from a price that is within budget.
`.trim();

type RunArgs = {
  callId: string;
  mandate: Mandate;
  carrier: CarrierSpec;
};

export async function runTextNegotiation({ callId, mandate, carrier }: RunArgs): Promise<void> {
  const emit = (kind: string, data: unknown) => {
    log(callId, kind as any, data);
    publish({ kind, callId, transport: "sim", data });
  };

  if (!carrier.persona) {
    emit("error", { where: "text-run", err: `carrier ${carrier.id} has no persona` });
    forceClose(callId, mandate, "no persona for scripted carrier", emit);
    return;
  }

  const dispatcher = new SimCarrier(carrier.name, carrier.persona, mandate);
  const tools = wrapTools(toolDefinitions);
  const messages: ChatMessage[] = [
    {
      role: "system",
      // Same round rules as the live carriers: get a quote, promise a callback,
      // do not book. The winner is decided afterwards.
      content: `${buildInstructions(mandate, {
        carrierName: carrier.name,
        collectingQuotes: true,
      })}\n\n${TEXT_PREAMBLE}`,
    },
    { role: "user", content: "Connected. The carrier's dispatcher is on the line." },
  ];

  let ended = false;

  try {
    for (let step = 0; step < MAX_STEPS && !ended; step++) {
      const out = await chat({ messages, tools, temperature: 0.3 });

      // Surface anything Volta "said" this turn.
      if (out.content && out.content.trim()) {
        emit("agent_transcript", out.content.trim());
        emit("carrier_transcript", {
          carrierId: carrier.id,
          carrierName: carrier.name,
          role: "volta",
          text: out.content.trim(),
        });
      }

      // --- tool turn -------------------------------------------------------
      if (out.tool_calls?.length) {
        messages.push({
          role: "assistant",
          content: out.content ?? "",
          tool_calls: out.tool_calls,
        });

        for (const tc of out.tool_calls) {
          let args: any = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            /* leave args empty */
          }
          const name = tc.function.name;
          emit("tool_call", { name, args });

          const result = await runTool(callId, name, args);
          emit("tool_result", { name, result });

          if (name === "log_carrier_offer" && (result as any).carrier) {
            emit("carrier_offer", (result as any).carrier);
          }
          if (name === "note_carrier_refusal") {
            emit("carrier_refusal", result);
          }
          if (name === "propose_commitment" && (result as any).committed) {
            emit("carrier_offer", { callId });
          }
          if (name === "end_negotiation") {
            emit("negotiation_done", result);
            ended = true;
          }

          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          });
        }
        continue; // let Volta react to the tool results
      }

      // --- talking turn: hand Volta's line to the dispatcher --------------
      if (!out.content || !out.content.trim()) {
        // Nothing to say and no tool: nudge and retry once.
        messages.push({ role: "assistant", content: "" });
        messages.push({ role: "user", content: "(the dispatcher waits for you to continue)" });
        continue;
      }

      messages.push({ role: "assistant", content: out.content });
      const reply = await dispatcher.reply(out.content.trim());
      emit("user_transcript", reply);
      emit("carrier_transcript", {
        carrierId: carrier.id,
        carrierName: carrier.name,
        role: "carrier",
        text: reply,
      });
      messages.push({ role: "user", content: reply });
    }

    if (!ended) {
      forceClose(callId, mandate, "sim negotiation did not converge", emit);
    }
  } catch (err) {
    emit("error", { where: "text-run", err: String(err) });
    forceClose(callId, mandate, `sim negotiation errored: ${String(err).slice(0, 140)}`, emit);
  }
}

// Close the record ourselves when Volta never reached end_negotiation.
function forceClose(
  callId: string,
  mandate: Mandate,
  summary: string,
  emit: (kind: string, data: unknown) => void
): void {
  const carrier = finalizeNegotiation(callId, {
    outcome: "no_deal",
    summary,
    mandate,
  });
  emit("negotiation_done", { ok: true, ending: true, outcome: "no_deal", carrier });
}
