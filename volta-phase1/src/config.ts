// -----------------------------------------------------------------------------
// config.ts
// Carga las variables de entorno una sola vez y las expone tipadas.
// Si falta alguna crítica, cortamos temprano con un error claro (mejor que
// fallar a mitad de una llamada).
// -----------------------------------------------------------------------------
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}. Revisá tu archivo .env`);
  }
  return value;
}

export const config = {
  openaiApiKey: required("OPENAI_API_KEY"),
  // Modelo Realtime. Se puede sobreescribir por env; si no, usa este default.
  openaiRealtimeModel: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",

  twilioAccountSid: required("TWILIO_ACCOUNT_SID"),
  twilioAuthToken: required("TWILIO_AUTH_TOKEN"),
  twilioFromNumber: required("TWILIO_FROM_NUMBER"),

  // Host público (ngrok en dev). Lo usamos para construir las URLs que Twilio
  // debe poder alcanzar: el webhook de TwiML y el WebSocket de media.
  publicHost: required("PUBLIC_HOST"),
  port: Number(process.env.PORT || 3000),
};
