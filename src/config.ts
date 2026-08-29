// -----------------------------------------------------------------------------
// config.ts
// No Twilio: all we need is the OpenAI API key and the port.
// -----------------------------------------------------------------------------
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}. Check your .env`);
  return value;
}

export const config = {
  openaiApiKey: required("OPENAI_API_KEY"),
  openaiRealtimeModel: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
  port: Number(process.env.PORT || 3000),
};
