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
    // A booked carrier changed the deal: either Volta could absorb it, or the
    // client has to decide.
    | "change_auto_accepted"
    | "change_needs_provider"
    | "provider_decided"
    | "escalation_done"
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

// Who is on the carrier side of a negotiation.
//   "human" = a person on the mic / phone (one of us in the demo).
//   "sim"   = a scripted persona driven by a text LLM.
export type CarrierKind = "human" | "sim";

// A carrier as listed for a round. Personas only matter for "sim".
export type SimPersona = {
  // Opening quote the dispatcher names first, in MXN.
  askPriceMxn: number;
  // Hard floor: never commits below this, in MXN.
  floorPriceMxn: number;
  // Earliest pickup they can commit to (ISO). Omit = flexible, fits any window.
  earliestPickup?: string;
  // Conditions / surcharges they attach (e.g. "48h advance notice").
  conditions?: string[];
  // How hard they hold their price. "low" concedes fast, "high" barely moves.
  stubbornness?: "low" | "medium" | "high";
  // Free-text flavour for the persona's tone.
  style?: string;
};

export type CarrierSpec = {
  id: string;
  name: string;
  kind: CarrierKind;
  // E.164 phone for a "human" carrier: the number Volta dials to reach them,
  // and the number it recognises them by when they call in. Without it Volta
  // can still talk to them, it just cannot tell WHICH carrier is on the line.
  phone?: string;
  persona?: SimPersona;
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
  // Round bookkeeping (set when the negotiation is part of a round).
  carrierId?: string;
  kind?: CarrierKind;
  roundId?: string;
};

// -----------------------------------------------------------------------------
// ROUND — negotiating one mandate against several carriers at once, then
// picking the winner. Persisted by store/negotiations.ts (db.decision).
// -----------------------------------------------------------------------------

// One carrier's standing in the comparison.
export type RankedCarrier = {
  callId: string;
  carrierId?: string;
  carrierName: string;
  kind?: CarrierKind;
  eligible: boolean;
  outcome?: "deal" | "no_deal";
  priceMxn?: number;
  pickupDelayDays: number;
  conditionCount: number;
  // Why it is not eligible to win (empty when eligible).
  disqualifiers: string[];
};

export type RoundComparison = {
  outcome: "deal" | "no_deal";
  winnerCallId?: string;
  ranking: RankedCarrier[]; // eligible first (by price), then the rest
  // Closed a deal but cannot win automatically (over cap, late, forbidden term).
  needsHumanReview: { callId: string; carrierName: string; why: string }[];
  reason: string;
};

export type RoundDecision = RoundComparison & {
  roundId: string;
  decidedAt: string;
};
