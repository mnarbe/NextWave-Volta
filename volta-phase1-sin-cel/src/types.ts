// -----------------------------------------------------------------------------
// types.ts
// El "lenguaje" del sistema. Igual que la versión con teléfono: lo que cambia
// es el transporte de audio (navegador en vez de Twilio), no el dominio.
// -----------------------------------------------------------------------------

// Lo que el humano autoriza al agente a negociar.
// Nota: la conversación es en INGLÉS, pero la moneda es MXN.
export type Mandate = {
  origin: string;            // ej: "Port of Manzanillo"
  destination: string;       // ej: "Warehouse in Guadalajara"
  containerNumber?: string;

  maxPriceMxn: number;       // tope de precio, ej: 9000
  pickupWindowStart: string; // ISO, ej: "2026-09-03T08:00"
  pickupWindowEnd: string;   // ej: "2026-09-03T18:00"

  forbiddenConditions?: string[]; // ej: ["prepayment", "no insurance"]
};

export type Proposal = {
  priceMxn: number;
  pickupTime: string;
  conditions?: string[];
};

// Lo que Volta captura del JURADO en la fase de intake. El precio máximo es el
// dato crítico (se usa después para negociar con los proveedores); el resto es
// best-effort. Se persiste en disco (mandateStore) para las fases siguientes.
export type NegotiationMandate = {
  maxPriceMxn: number;
  currency: "MXN";
  origin?: string;
  destination?: string;
  containerNumber?: string;
  pickupWindowStart?: string; // ISO, ej: "2026-09-03T08:00"
  pickupWindowEnd?: string;
  forbiddenConditions?: string[];
  notes?: string;
  capturedAt: string;         // ISO
};

export type MandateCheck = {
  decision: "allowed" | "rejected" | "needs_escalation";
  reasons: string[];
};

export type Commitment = {
  id: string;
  callId: string;
  priceMxn: number;
  pickupTime: string;
  conditions: string[];
  agreedByName?: string;
  createdAt: string;
  // Momento exacto del audio de la llamada en el que se cerró el compromiso.
  // Con esto un auditor abre data/audio/<callId>/in.wav y salta al segundo.
  agreedAtAudioMs?: number;
  // TODO (Fase siguiente): recapMessageId + status verificado por recap.
};

export type LogEntry = {
  ts: string;
  callId: string;
  // ms desde el inicio del audio de la llamada (si el transporte lleva reloj).
  audioMs?: number;
  kind:
    | "call_started"
    | "call_ended"
    | "user_transcript"
    | "agent_transcript"
    | "tool_call"
    | "tool_result"
    | "barge_in"
    | "mandate_captured"
    | "intake_done"
    | "carrier_refusal"
    | "negotiation_done"
    | "call_status"
    | "dtmf"
    | "note"
    | "error";
  data: unknown;
};

export type CallState = {
  callId: string;
  mandate: Mandate | null; // null en la fase de intake (todavía no se capturó)
  commitments: Commitment[];
  log: LogEntry[];
  refusals: number; // veces que el carrier se negó a bajar el precio (fase negociación)
};
