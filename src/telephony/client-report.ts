// -----------------------------------------------------------------------------
// client-report.ts
//
// A manual, post-round client update. It has its own call mode and is never
// invoked by negotiation code. The dashboard must explicitly request it.
// -----------------------------------------------------------------------------
import { config, twilioReady } from "../config.js";
import { publish } from "../bus.js";
import { currentClientCarrierReport } from "../intelligence/client-report.js";
import { dialWhenFree, SETTLE_MS } from "./line.js";
import { providerNumber } from "./escalation-calls.js";
import { placeCall } from "./twilio.js";

export type ClientReportResult =
  | { ok: true; carrierName: string; to: string }
  | { ok: false; reason: "no_eligible_carrier" | "no_provider_number" | "twilio_not_ready" };

export function callClientReport(): ClientReportResult {
  const report = currentClientCarrierReport();
  if (!report) return { ok: false, reason: "no_eligible_carrier" };

  const to = providerNumber();
  if (!to) return { ok: false, reason: "no_provider_number" };
  if (!twilioReady()) return { ok: false, reason: "twilio_not_ready" };

  publish({
    kind: "client_report_scheduled",
    callId: `report:${Date.now()}`,
    transport: "phone",
    data: { carrierName: report.carrierName, to, delayMs: SETTLE_MS },
  });

  // The confirmation call may still be finishing. Wait for the line rather
  // than placing two calls at once.
  dialWhenFree(async () => {
    try {
      const call = await placeCall({ to, mode: "report", intent: "client_report" });
      console.log(`[client-report] calling ${to}, sid=${call.sid}`);
    } catch (err: any) {
      console.error(`[client-report] call failed: ${err.message}`);
      publish({
        kind: "client_report_failed",
        callId: `report:${Date.now()}`,
        transport: "phone",
        data: { carrierName: report.carrierName, to, error: err.message },
      });
    }
  }, SETTLE_MS);

  return { ok: true, carrierName: report.carrierName, to };
}
