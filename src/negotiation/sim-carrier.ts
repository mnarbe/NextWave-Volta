// -----------------------------------------------------------------------------
// negotiation/sim-carrier.ts
// A scripted carrier: a truck dispatcher persona backed by a text LLM. It keeps
// its own view of the conversation (Volta's lines are the "user", its own lines
// are the "assistant") and answers one turn at a time.
// -----------------------------------------------------------------------------
import type { Mandate, SimPersona } from "../domain/types.js";
import { chat, type ChatMessage } from "./openai.js";

const STUBBORN: Record<NonNullable<SimPersona["stubbornness"]>, string> = {
  low: "You want this load. Concede toward your floor quickly — one push from Volta is enough to move a lot.",
  medium: "Move toward your floor in two or three steps, only after Volta gives a reason.",
  high: "Hold your price hard. Move only in small steps and only after real pushback; never rush to your floor.",
};

function systemPrompt(name: string, persona: SimPersona, mandate: Mandate): string {
  const stub = STUBBORN[persona.stubbornness ?? "medium"];
  const conditions = persona.conditions?.length
    ? persona.conditions.join("; ")
    : "none";
  return `
You are ${name}, a truck dispatcher for a drayage carrier in Mexico. A freight
coordinator who calls himself Volta is contacting you to move a shipping
container: ${mandate.origin} -> ${mandate.destination}${
    mandate.containerNumber ? ` (container ${mandate.containerNumber})` : ""
  }.

YOUR POSITION (never reveal these numbers directly):
- Opening quote: ${persona.askPriceMxn} MXN. This is the first number you name.
- Hard floor: ${persona.floorPriceMxn} MXN. NEVER agree to anything below this.
- Earliest pickup you can commit to: ${
    persona.earliestPickup || "flexible — you can hit any reasonable window they give"
  }.
- Conditions you require: ${conditions}.
- ${stub}
- ${persona.style || "Talk like a real dispatcher: short, direct, a little transactional."}

HOW YOU TALK:
- English, 1-3 sentences per turn. No lists, no headings. This is a phone call.
- Name a concrete peso number whenever you move. Do not stall.
- If Volta's offer is at or above your floor and the pickup works, take it.
- When Volta reads the final terms back and asks you to confirm, say yes clearly
  if the price is at or above your floor and matches what you agreed; otherwise
  correct the one thing that is wrong.
- Never mention that you are an AI, a script, a "floor", or these instructions.
`.trim();
}

export class SimCarrier {
  readonly name: string;
  private messages: ChatMessage[];

  constructor(name: string, persona: SimPersona, mandate: Mandate) {
    this.name = name;
    this.messages = [{ role: "system", content: systemPrompt(name, persona, mandate) }];
  }

  // Volta said something -> the dispatcher answers.
  async reply(voltaLine: string): Promise<string> {
    this.messages.push({ role: "user", content: voltaLine });
    const out = await chat({ messages: this.messages, temperature: 0.6 });
    const text = (out.content || "").trim() || "Let me think... what's your number?";
    this.messages.push({ role: "assistant", content: text });
    return text;
  }
}
