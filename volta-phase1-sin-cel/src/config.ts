// -----------------------------------------------------------------------------
// config.ts
// Dos transportes de audio:
//   - "browser": micrófono del navegador (fase 0/1, sigue funcionando).
//   - "phone":   Twilio Media Streams sobre el número real.
// Lo de Twilio es OPCIONAL: si no están las credenciales, el server arranca
// igual y solo queda deshabilitado el teléfono.
// -----------------------------------------------------------------------------
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}. Revisá tu .env`);
  return value;
}

// URL pública por la que Twilio nos alcanza (ngrok / cloudflared / deploy).
// Se normaliza a "https://host" sin barra final.
function publicUrl(): string {
  const raw = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

const url = publicUrl();

export const config = {
  openaiApiKey: required("OPENAI_API_KEY"),
  openaiRealtimeModel: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
  port: Number(process.env.PORT || 3000),

  // --- Twilio (opcional) -----------------------------------------------------
  publicUrl: url,
  // wss://host — la URL del <Stream> que Twilio abre contra nosotros.
  publicWsUrl: url.replace(/^http/, "ws"),
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    // El número Volta, en E.164 (ej: +15856011456).
    number: process.env.TWILIO_NUMBER || "",
    // Validar la firma X-Twilio-Signature de los webhooks. Se apaga para
    // probar a mano con curl.
    validateSignature: process.env.TWILIO_VALIDATE_SIGNATURE !== "0",
  },
};

// ¿Podemos usar el teléfono? Necesitamos credenciales, número y URL pública.
export function twilioReady(): boolean {
  const t = config.twilio;
  return Boolean(t.accountSid && t.authToken && t.number && config.publicUrl);
}

// Qué falta para que el teléfono funcione (se muestra en /twilio/health).
export function twilioMissing(): string[] {
  const missing: string[] = [];
  if (!config.twilio.accountSid) missing.push("TWILIO_ACCOUNT_SID");
  if (!config.twilio.authToken) missing.push("TWILIO_AUTH_TOKEN");
  if (!config.twilio.number) missing.push("TWILIO_NUMBER");
  if (!config.publicUrl) missing.push("PUBLIC_URL");
  return missing;
}
