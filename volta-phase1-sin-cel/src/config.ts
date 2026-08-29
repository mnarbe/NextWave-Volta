// -----------------------------------------------------------------------------
// config.ts
// OpenAI es obligatorio. Twilio es OPCIONAL: sin las variables de Twilio el
// server arranca igual y funciona el flujo por navegador (el fallback de demo).
// -----------------------------------------------------------------------------
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}. Revisá tu .env`);
  return value;
}

const twilio = {
  accountSid: process.env.TWILIO_ACCOUNT_SID || "",
  authToken: process.env.TWILIO_AUTH_TOKEN || "",
  fromNumber: process.env.TWILIO_PHONE_NUMBER || "",
  // Base pública (ngrok o el host donde deployees). Sin barra final.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
};

export const config = {
  openaiApiKey: required("OPENAI_API_KEY"),
  openaiRealtimeModel: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
  port: Number(process.env.PORT || 3000),
  // Zona horaria en la que se interpretan las fechas del mandato sin zona
  // explícita. México (Manzanillo/Guadalajara) = UTC-6.
  mandateTzOffset: process.env.MANDATE_TZ_OFFSET || "-06:00",
  twilio,
  // Solo registramos las rutas de teléfono si están las 4 variables.
  twilioEnabled: Boolean(
    twilio.accountSid && twilio.authToken && twilio.fromNumber && twilio.publicBaseUrl
  ),
};

// El host wss:// que Twilio va a usar para el Media Stream.
export function wsBaseUrl(): string {
  return config.twilio.publicBaseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}
