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
  // "intake" = talk to the provider. "negotiate" = negotiate with a carrier.
  mode: "intake" | "negotiate";
  // Carrier name, if we know it upfront (UI only).
  carrier?: string;
  // The other party's number (E.164), whichever side dialled. The media
  // stream needs it to hand off to the next call when this one ends.
  peer?: string;
};

// The WSS URL Twilio opens against us, with the mode in the query string.
export function streamUrl(params: StreamParams): string {
  const q = new URLSearchParams({ mode: params.mode });
  if (params.carrier) q.set("carrier", params.carrier);
  if (params.peer) q.set("peer", params.peer);
  return `${config.publicWsUrl}/twilio/media?${q.toString()}`;
}

// <Connect><Stream> is the BIDIRECTIONAL mode: Twilio sends us the other
// party's audio and plays back whatever we return. (<Start><Stream> would be
// listen-only.) When we close the WebSocket the <Connect> ends and, since there
// is no further TwiML, Twilio hangs up.
//
// How the mode/peer reach us matters. We send them BOTH ways:
//   - as <Parameter> children, which Twilio hands over in the "start" event as
//     start.customParameters. This is the documented mechanism and the one we
//     trust.
//   - in the URL query string, as a fallback (and so that a WebSocket client
//     connecting by hand, like scripts/fake-twilio.mjs, can still pick a mode).
// Relying on the query string alone silently dropped the mode: every carrier
// call fell back to the intake script, and the handoff lost the number to call
// back.
export function streamTwiml(params: StreamParams): string {
  const parameters = [
    `<Parameter name="mode" value="${xmlEscape(params.mode)}"/>`,
    params.peer ? `<Parameter name="peer" value="${xmlEscape(params.peer)}"/>` : "",
    params.carrier ? `<Parameter name="carrier" value="${xmlEscape(params.carrier)}"/>` : "",
  ].join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Connect>` +
    `<Stream url="${xmlEscape(streamUrl(params))}">${parameters}</Stream>` +
    `</Connect></Response>`
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
    twiml: streamTwiml({ mode: opts.mode, carrier: opts.carrier, peer: opts.to }),
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
// Points EVERY number we use at this machine: the main one, and the optional
// carrier number if TWILIO_CARRIER_NUMBER is set. A number with an empty
// voiceUrl simply does nothing when you call it, which is easy to miss.
export async function configureAllNumbers() {
  const numbers = [config.twilio.number, config.twilio.carrierNumber].filter(Boolean);
  const results = [];
  for (const n of numbers) {
    results.push({
      ...(await configureNumber(n)),
      role: n === config.twilio.carrierNumber ? "carrier" : "provider",
    });
  }
  return results;
}

export async function configureNumber(phoneNumber = config.twilio.number) {
  const c = twilioClient();
  const [number] = await c.incomingPhoneNumbers.list({
    phoneNumber,
    limit: 1,
  });
  if (!number) {
    throw new Error(`Number ${phoneNumber} is not on this Twilio account.`);
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
