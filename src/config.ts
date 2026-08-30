// -----------------------------------------------------------------------------
// config.ts
// Two audio transports:
//   - "browser": the browser's microphone (demo fallback).
//   - "phone":   Twilio Media Streams over the real number.
// Twilio is OPTIONAL: without credentials the server still boots, only the
// phone is disabled.
// -----------------------------------------------------------------------------
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}. Check your .env`);
  return value;
}

// Public URL Twilio reaches us on (ngrok tunnel, or a deploy).
// Normalised to "https://host" with no trailing slash.
function publicUrl(): string {
  const raw = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

const url = publicUrl();

export const config = {
  openaiApiKey: required("OPENAI_API_KEY"),
  openaiRealtimeModel: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
  // Text model for the parallel round: the scripted carrier personas and the
  // text-driven Volta that negotiates against them.
  openaiTextModel: process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini",
  port: Number(process.env.PORT || 3000),

  // In a round, where the ONE human carrier (one of us) comes in from.
  //   "browser" = the dashboard's microphone mode.
  //   "phone"   = Volta dials a number via POST /call.
  humanCarrierTransport:
    (process.env.HUMAN_CARRIER_TRANSPORT || "browser").toLowerCase() === "phone"
      ? ("phone" as const)
      : ("browser" as const),

  // --- Twilio (optional) -----------------------------------------------------
  publicUrl: url,
  // wss://host — the <Stream> URL Twilio opens against us.
  publicWsUrl: url.replace(/^http/, "ws"),
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    // Volta's number, E.164 (e.g. +15856011456).
    number: process.env.TWILIO_NUMBER || "",
    // Verify the X-Twilio-Signature on webhooks. Turn off to poke them by hand
    // with curl.
    validateSignature: process.env.TWILIO_VALIDATE_SIGNATURE !== "0",
  },
};

// Can we use the phone? We need credentials, a number and a public URL.
export function twilioReady(): boolean {
  const t = config.twilio;
  return Boolean(t.accountSid && t.authToken && t.number && config.publicUrl);
}

// What is missing for the phone to work (shown in /twilio/health).
export function twilioMissing(): string[] {
  const missing: string[] = [];
  if (!config.twilio.accountSid) missing.push("TWILIO_ACCOUNT_SID");
  if (!config.twilio.authToken) missing.push("TWILIO_AUTH_TOKEN");
  if (!config.twilio.number) missing.push("TWILIO_NUMBER");
  if (!config.publicUrl) missing.push("PUBLIC_URL");
  return missing;
}
