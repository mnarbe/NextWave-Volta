// -----------------------------------------------------------------------------
// session.ts
// Starting a "call" is the same whether it comes from the browser or the phone:
// resolve the mandate, open the negotiation record, bring up the bridge to
// OpenAI, and publish every business event to the bus (dashboards).
// The only thing that differs between transports is where the AUDIO goes.
// -----------------------------------------------------------------------------
import { createCall } from "./store/calls.js";
import { getMandate } from "./store/mandates.js";
import { beginNegotiation, type CarrierMeta } from "./store/negotiations.js";
import { toMandate } from "./domain/mandate.js";
import { DEFAULT_MANDATE } from "./domain/defaults.js";
import { RealtimeBridge, type Phase, type Transport } from "./agent/realtime.js";
import { publish } from "./bus.js";
import type { Mandate } from "./domain/types.js";

// SYNC-READ: getMandate() reads without awaiting. If persistence ever goes
// async, this function (and its callers) have to become async too.
export function resolveMandate(mode: Phase, override?: Mandate | null): Mandate | null {
  if (mode !== "negotiate") return null;
  if (override) return override;
  const captured = getMandate();
  return captured ? toMandate(captured) : DEFAULT_MANDATE;
}

export type SessionOptions = {
  mode: Phase;
  transport: Transport;
  mandate?: Mandate | null;
  // When this session is the human carrier of a round: its pre-created callId
  // and the carrier/round tags to stamp on the negotiation record.
  callId?: string;
  carrier?: CarrierMeta;
  // Volta's audio out to the transport (speakers or Twilio).
  sendAudio: (base64: string) => void;
  clearAudio: () => void;
  // Volta finished its closing line: the transport decides how to hang up.
  onFinal: () => void;
};

export type Session = {
  callId: string;
  bridge: RealtimeBridge;
  mandate: Mandate | null;
};

export function startSession(opts: SessionOptions): Session {
  const mandate = resolveMandate(opts.mode, opts.mandate);
  const callId = createCall(mandate, opts.callId);

  // Open the negotiation record for this carrier (Volta fills the name in via
  // log_carrier_offer once it knows it). `opts.carrier` is set when this session
  // is a round's human carrier.
  if (opts.mode === "negotiate") beginNegotiation(callId, mandate, opts.carrier);

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
    data: { mode: opts.mode, mandate, carrier: opts.carrier },
  });

  return { callId, bridge, mandate };
}
