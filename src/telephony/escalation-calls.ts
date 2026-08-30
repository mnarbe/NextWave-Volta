// -----------------------------------------------------------------------------
// telephony/escalation-calls.ts
// The two phone calls an escalation needs, and who to ring for each.
//
//   1. a booked carrier changed something Volta cannot accept
//        -> ring the PROVIDER, explain, ask for a yes or no  (mode "escalate")
//   2. the provider answered
//        -> ring the CARRIER back, to confirm the change or to cancel
//
// Deciding WHETHER a change needs the provider is not here — that is
// negotiation/escalation.ts, in code. This module only moves the calls.
// -----------------------------------------------------------------------------
import { config, twilioReady } from "../config.js";
import { publish } from "../bus.js";
import { placeCall } from "./twilio.js";
import { expectCarrier } from "./routing.js";
import { dialWhenFree, SETTLE_MS } from "./line.js";
import { loadRoster } from "../negotiation/roster.js";
import { pendingChange, lastResolvedChange } from "../negotiation/escalation.js";

// Long enough for Twilio to tear the previous call down.
const NEXT_CALL_DELAY_MS = SETTLE_MS;

function dialable(n: string | undefined): n is string {
  return Boolean(n && /^\+[1-9]\d{6,15}$/.test(n));
}

// Who to ring for the client. The provider's own number is remembered from the
// intake call; the demo phone is the fallback.
export function providerNumber(): string | undefined {
  const n = config.providerNumber || config.demoCarrierNumber;
  return dialable(n) ? n : undefined;
}

function carrierNumber(carrierId?: string): string | undefined {
  const spec = loadRoster().find((c) => c.id === carrierId && c.kind === "human");
  const n = spec?.phone || config.demoCarrierNumber;
  return dialable(n) ? n : undefined;
}

function ring(opts: {
  to: string;
  mode: "escalate" | "negotiate";
  carrier?: string;
  callId: string;
  kind: string;
  data: Record<string, unknown>;
}): void {
  publish({
    kind: opts.kind,
    callId: opts.callId,
    transport: "phone",
    data: { ...opts.data, to: opts.to, delayMs: NEXT_CALL_DELAY_MS },
  });

  // Hold until the call that triggered this has actually hung up.
  dialWhenFree(async () => {
    try {
      const call = await placeCall({ to: opts.to, mode: opts.mode, carrier: opts.carrier });
      console.log(`[escalation] ${opts.mode} call to ${opts.to}, sid=${call.sid}`);
    } catch (err: any) {
      console.error(`[escalation] ${opts.mode} call failed: ${err.message}`);
      publish({
        kind: `${opts.kind}_failed`,
        callId: opts.callId,
        transport: "phone",
        data: { to: opts.to, error: err.message },
      });
    }
  }, NEXT_CALL_DELAY_MS);
}

// A carrier call just ended and left a change waiting on the client. Ring them.
export function escalateToProvider(fromCallId: string): boolean {
  const change = pendingChange();
  if (!change) return false;

  const to = providerNumber();
  if (!twilioReady() || !to) {
    console.log(`[escalation] change pending but no provider number to call`);
    publish({
      kind: "escalation_call_skipped",
      callId: fromCallId,
      transport: "phone",
      data: { reason: to ? "twilio_not_ready" : "no_provider_number", change },
    });
    return false;
  }

  console.log(
    `[escalation] ${change.carrierName} changed the deal — asking the client at ${to}`
  );
  ring({
    to,
    mode: "escalate",
    callId: fromCallId,
    kind: "escalation_call_scheduled",
    data: { carrierName: change.carrierName, reasons: change.reasons },
  });
  return true;
}

// The client answered. Ring the carrier back with the verdict.
export function reportBackToCarrier(fromCallId: string): boolean {
  const change = lastResolvedChange();
  if (!change) return false;

  const to = carrierNumber(change.carrierId);
  if (!twilioReady() || !to) {
    console.log(`[escalation] decided (${change.status}) but no carrier number to call`);
    publish({
      kind: "carrier_report_skipped",
      callId: fromCallId,
      transport: "phone",
      data: { reason: to ? "twilio_not_ready" : "no_carrier_number", change },
    });
    return false;
  }

  // They are expecting our call, so an inbound from them is still the carrier.
  expectCarrier(to);

  console.log(
    `[escalation] client said ${change.status} — telling ${change.carrierName} at ${to}`
  );
  ring({
    to,
    mode: "negotiate",
    carrier: change.carrierName,
    callId: fromCallId,
    kind: "carrier_report_scheduled",
    data: { carrierName: change.carrierName, approved: change.status === "approved" },
  });
  return true;
}
