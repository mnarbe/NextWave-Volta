// -----------------------------------------------------------------------------
// types.ts
// El "lenguaje" del sistema en Fase 1. Deliberadamente mínimo: solo lo necesario
// para una llamada y una negociación. En fases siguientes crecen (cotizaciones,
// comparador, recap, timestamps, etc.).
// -----------------------------------------------------------------------------

// Lo que el humano autoriza al agente a negociar.
export type Mandate = {
  // Contexto del envío (para que el agente sepa de qué habla).
  origin: string;        // ej: "Puerto de Manzanillo"
  destination: string;   // ej: "Bodega en Guadalajara"
  containerNumber?: string;

  // Los límites duros de la negociación:
  maxPriceMxn: number;   // tope de precio, ej: 9000
  pickupWindowStart: string; // ISO o texto simple, ej: "2026-09-03T08:00"
  pickupWindowEnd: string;   // ej: "2026-09-03T18:00"

  // Cosas que el agente NO puede aceptar (texto libre para Fase 1).
  forbiddenConditions?: string[]; // ej: ["pago por adelantado", "sin seguro"]
};

// Una propuesta concreta que el transportista pone sobre la mesa y que
// queremos validar contra el mandato.
export type Proposal = {
  priceMxn: number;
  pickupTime: string; // ISO o texto
  conditions?: string[];
};

// Resultado de validar una propuesta contra el mandato.
export type MandateCheck = {
  decision: "allowed" | "rejected" | "needs_escalation";
  reasons: string[]; // por qué; sirve para que el agente lo explique y para el log
};

// Un compromiso ya validado (en Fase 1 aún sin recap ni timestamp de audio;
// esos campos llegan en Fase 2, marcados como TODO abajo).
export type Commitment = {
  id: string;
  callId: string;
  priceMxn: number;
  pickupTime: string;
  conditions: string[];
  agreedByName?: string;   // nombre del despachador, si lo dio
  createdAt: string;       // wall-clock time
  // TODO (Fase 2): recapMessageId, agreedAtAudioMs, status verificado.
};

// Una entrada de log. Todo lo interesante que pasa en una llamada cae acá.
export type LogEntry = {
  ts: string;                 // cuándo
  callId: string;
  kind:
    | "call_started"
    | "call_ended"
    | "user_transcript"       // lo que dijo la persona (transcripción)
    | "agent_transcript"      // lo que dijo Volta
    | "tool_call"             // el modelo pidió una tool
    | "tool_result"           // lo que devolvió la tool
    | "barge_in"              // la persona interrumpió
    | "error";
  data: unknown;              // payload libre según el kind
};

// Estado en memoria de una llamada en curso.
export type CallState = {
  callId: string;
  mandate: Mandate;
  streamSid?: string;         // id del media stream de Twilio (para responder audio)
  commitments: Commitment[];
  log: LogEntry[];
};
