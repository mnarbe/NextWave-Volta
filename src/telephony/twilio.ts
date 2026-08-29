// -----------------------------------------------------------------------------
// telephony/twilio.ts
// Everything we ask Twilio over REST/TwiML:
//   - the TwiML that opens the bidirectional Media Stream against our WSS,
//   - OUTBOUND calls (Volta calls the carrier),
//   - pointing the number's webhook at this machine (so nobody has to open the
//     Twilio console),
//   - hanging up a call.
//
// Audio does NOT go through here: that is telephony/stream.ts.
// -----------------------------------------------------------------------------
import twilioSdk from "twilio";
import { config, twilioReady, twilioMissing } from "../config.js";

let client: ReturnType<typeof twilioSdk> | null = null;

export function twilioClient() {
  if (!twilioReady()) {
    throw new Error(`Twilio is not configured. Missing: ${twilioMissing().join(", ")}`);
  }
  if (!client) {
    client = twilioSdk(config.twilio.accountSid, config.twilio.authToken);
  }
  return client;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type StreamParams = {
  // "intake" = talk to the client. "negotiate" = negotiate with a carrier.
  mode: "intake" | "negotiate";
  // Carrier name, if we know it upfront (UI only).
  carrier?: string;
};

// The WSS URL Twilio opens against us, with the mode in the query string.
export function streamUrl(params: StreamParams): string {
  const q = new URLSearchParams({ mode: params.mode });
  if (params.carrier) q.set("carrier", params.carrier);
  return `${config.publicWsUrl}/twilio/media?${q.toString()}`;
}

// <Connect><Stream> is the BIDIRECTIONAL mode: Twilio sends us the other
// party's audio and plays back whatever we return. (<Start><Stream> would be
// listen-only.) When we close the WebSocket the <Connect> ends and, since there
// is no further TwiML, Twilio hangs up.
export function streamTwiml(params: StreamParams): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Connect><Stream url="${xmlEscape(streamUrl(params))}"/></Connect></Response>`
  );
}

// OUTBOUND call: Volta dials the carrier. The TwiML goes inline (the `twiml`
// parameter), so outbound calls need no second webhook.
export async function placeCall(opts: {
  to: string;
  mode: "intake" | "negotiate";
  carrier?: string;
}) {
  const call = await twilioClient().calls.create({
    to: opts.to,
    from: config.twilio.number,
    twiml: streamTwiml({ mode: opts.mode, carrier: opts.carrier }),
    statusCallback: `${config.publicUrl}/twilio/status`,
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
  });
  return { sid: call.sid, to: call.to, status: call.status };
}

export async function hangup(callSid: string) {
  await twilioClient().calls(callSid).update({ status: "completed" });
}

// Points the number at THIS machine (voiceUrl -> /twilio/voice). This is what
// saves you from editing the webhook by hand in the Twilio console every time
// the public URL changes.
export async function configureNumber() {
  const c = twilioClient();
  const [number] = await c.incomingPhoneNumbers.list({
    phoneNumber: config.twilio.number,
    limit: 1,
  });
  if (!number) {
    throw new Error(`Number ${config.twilio.number} is not on this Twilio account.`);
  }
  const updated = await c.incomingPhoneNumbers(number.sid).update({
    voiceUrl: `${config.publicUrl}/twilio/voice`,
    voiceMethod: "POST",
    statusCallback: `${config.publicUrl}/twilio/status`,
    statusCallbackMethod: "POST",
  });
  return {
    sid: updated.sid,
    phoneNumber: updated.phoneNumber,
    voiceUrl: updated.voiceUrl,
  };
}

// Are we allowed to call this country? Twilio blocks much of the world by
// default (Voice Dialing Permissions). If the carrier is +52 (Mexico) and it is
// not enabled, the call fails with error 13227/21215.
export async function geoPermission(isoCode: string) {
  const country = await twilioClient()
    .voice.v1.dialingPermissions.countries(isoCode.toUpperCase())
    .fetch();
  return {
    country: country.name,
    isoCode: country.isoCode,
    lowRiskNumbersEnabled: country.lowRiskNumbersEnabled,
    highRiskSpecialNumbersEnabled: country.highRiskSpecialNumbersEnabled,
    highRiskTollfraudNumbersEnabled: country.highRiskTollfraudNumbersEnabled,
  };
}

// Going from "+5215512345678" to "MX" properly needs a lookup table; we cover
// the prefixes that matter for the demo and default to US.
export function guessIso(e164: string): string {
  const n = e164.replace(/[^\d+]/g, "");
  if (n.startsWith("+52")) return "MX";
  if (n.startsWith("+54")) return "AR";
  if (n.startsWith("+55")) return "BR";
  if (n.startsWith("+34")) return "ES";
  if (n.startsWith("+1")) return "US";
  return "US";
}
