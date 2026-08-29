// -----------------------------------------------------------------------------
// config.ts
// Sin Twilio: solo necesitamos la API key de OpenAI y el puerto.
// -----------------------------------------------------------------------------
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}. Revisá tu .env`);
  return value;
}

export const config = {
  openaiApiKey: required("OPENAI_API_KEY"),
  openaiRealtimeModel: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
  port: Number(process.env.PORT || 3000),
};
