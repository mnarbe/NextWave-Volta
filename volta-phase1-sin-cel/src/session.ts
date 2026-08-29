// -----------------------------------------------------------------------------
// session.ts
// Arrancar una "llamada" es lo mismo venga del navegador o del teléfono:
// resolver el mandato, abrir el registro de negociación, levantar el puente con
// OpenAI y mandar todos los eventos de negocio al bus (dashboards).
// Lo único que cambia entre transportes es a dónde va el AUDIO.
// -----------------------------------------------------------------------------
import { createCall } from "./store.js";
import { RealtimeBridge, type Phase, type Transport } from "./voice/realtime.js";
import { getMandate } from "./storage/mandateStore.js";
import { beginNegotiation } from "./storage/negotiationStore.js";
import { publish } from "./bus.js";
import type { Mandate, NegotiationMandate } from "./types.js";

// Mandato por defecto para la fase de NEGOCIACIÓN, si el jurado todavía no
// dictó el suyo. En intake no se usa: el mandato lo captura Volta hablando.
export const DEFAULT_MANDATE: Mandate = {
  origin: "Port of Manzanillo",
  destination: "Warehouse in Guadalajara",
  containerNumber: "MSCU1234567",
  maxPriceMxn: 9000,
  pickupWindowStart: "2026-09-03T08:00",
  pickupWindowEnd: "2026-09-03T18:00",
  forbiddenConditions: ["prepayment", "no insurance"],
};

// Ventana "abierta": si el jurado no dio fechas, no queremos que checkMandate
// rechace por horario. Solo el precio es límite duro.
const OPEN_WINDOW_START = "2000-01-01T00:00";
const OPEN_WINDOW_END = "2100-01-01T00:00";

// El mandato capturado del jurado (NegotiationMandate) -> el shape que usa la
// fase de negociación (Mandate), completando lo que falte.
export function toNegotiationMandate(m: NegotiationMandate): Mandate {
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

export function resolveMandate(mode: Phase, override?: Mandate | null): Mandate | null {
  if (mode !== "negotiate") return null;
  if (override) return override;
  const captured = getMandate();
  return captured ? toNegotiationMandate(captured) : DEFAULT_MANDATE;
}

export type SessionOptions = {
  mode: Phase;
  transport: Transport;
  mandate?: Mandate | null;
  // Audio de Volta hacia el transporte (parlantes o Twilio).
  sendAudio: (base64: string) => void;
  clearAudio: () => void;
  // Volta terminó su frase de cierre: el transporte decide cómo colgar.
  onFinal: () => void;
};

export type Session = {
  callId: string;
  bridge: RealtimeBridge;
  mandate: Mandate | null;
};

export function startSession(opts: SessionOptions): Session {
  const mandate = resolveMandate(opts.mode, opts.mandate);
  const callId = createCall(mandate);

  // Abrimos el registro de negociación para este carrier (el nombre lo
  // completa Volta con log_carrier_offer cuando lo sepa).
  if (opts.mode === "negotiate") beginNegotiation(callId, mandate);

  const bridge = new RealtimeBridge(
    callId,
    {
      sendAudio: opts.sendAudio,
      clearAudio: opts.clearAudio,
      onEvent: (kind, data) =>
        publish({ kind, callId, transport: opts.transport, data }),
      onFinal: opts.onFinal,
    },
    { phase: opts.mode, transport: opts.transport }
  );

  publish({
    kind: "call_started",
    callId,
    transport: opts.transport,
    data: { mode: opts.mode, mandate },
  });

  return { callId, bridge, mandate };
}
