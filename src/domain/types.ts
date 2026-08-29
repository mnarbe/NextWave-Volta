// -----------------------------------------------------------------------------
// domain/types.ts
// The "language" of the system. Same as the phone version: what changed is the
// audio transport (browser instead of Twilio), not the domain.
// -----------------------------------------------------------------------------

// What the human authorizes the agent to negotiate.
// Note: the conversation is in ENGLISH, but the currency is MXN.
export type Mandate = {
  origin: string;            // e.g. "Port of Manzanillo"
  destination: string;       // e.g. "Warehouse in Guadalajara"
  containerNumber?: string;

  maxPriceMxn: number;       // price cap, e.g. 9000
  pickupWindowStart: string; // ISO, e.g. "2026-09-03T08:00"
  pickupWindowEnd: string;   // e.g. "2026-09-03T18:00"

  forbiddenConditions?: string[]; // e.g. ["prepayment", "no insurance"]
};

export type Proposal = {
  priceMxn: number;
  pickupTime: string;
  conditions?: string[];
};

// What Volta captures from the CLIENT during intake. The maximum price is the
// critical field (it drives the later negotiation with carriers); the rest is
// best-effort. Persisted to disk (store/mandates.ts) for the next phases.
export type NegotiationMandate = {
  maxPriceMxn: number;
  currency: "MXN";
  origin?: string;
  destination?: string;
  containerNumber?: string;
  pickupWindowStart?: string; // ISO, e.g. "2026-09-03T08:00"
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
  // TODO (Phase 2): recapMessageId, agreedAtAudioMs, verified status.
};

export type LogEntry = {
  ts: string;
  callId: string;
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
    | "carrier_offer"
    | "carrier_refusal"
    | "negotiation_done"
    | "error";
  data: unknown;
};

export type CallState = {
  callId: string;
  mandate: Mandate | null; // null during intake (nothing captured yet)
  commitments: Commitment[];
  log: LogEntry[];
  refusals: number; // times the carrier refused to lower the price (negotiation)
};

// -----------------------------------------------------------------------------
// CARRIER NEGOTIATION
// What Volta gets out of each carrier, for the dashboard and for what has to be
// relayed to the client afterwards. Persisted by store/negotiations.ts.
// -----------------------------------------------------------------------------

// A single carrier offer: what they said at one point in the call.
export type CarrierOffer = {
  ts: string;
  priceMxn?: number;
  pickupTime?: string;
  pickupDelayDays?: number; // >0 = later than the window the client asked for
  delayNote?: string; // free text about the date slip ("earliest is Friday")
  conditions: string[]; // conditions / caveats the carrier attaches
  note?: string;
};

export type CarrierFinal = {
  outcome: "deal" | "no_deal";
  priceMxn?: number;
  pickupTime?: string;
  pickupDelayDays?: number;
  delayNote?: string;
  conditionsToRelay: string[]; // what has to be relayed to the client
  priceWithinCap?: boolean;
  summary?: string;
  decidedAt: string;
};

export type CarrierNegotiation = {
  callId: string;
  carrierName: string;
  startedAt: string;
  offers: CarrierOffer[];
  // Consolidated view: last non-empty value per field + union of conditions.
  latest: {
    priceMxn?: number;
    pickupTime?: string;
    pickupDelayDays?: number;
    delayNote?: string;
    conditions: string[];
  };
  refusals: number;
  status: "in_progress" | "deal" | "no_deal";
  final?: CarrierFinal;
  mandateSnapshot?: Mandate | null;
};
