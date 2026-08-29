// -----------------------------------------------------------------------------
// twilio/client.ts
// Cliente REST de Twilio + disparo de llamadas salientes.
// Se instancia perezosamente: si no hay credenciales, el server igual arranca
// y funciona el flujo por navegador.
// -----------------------------------------------------------------------------
import twilio from "twilio";
import { config } from "../config.js";

let client: ReturnType<typeof twilio> | null = null;

export function twilioClient() {
  if (!config.twilioEnabled) {
    throw new Error(
      "Twilio no está configurado. Faltan TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / " +
        "TWILIO_PHONE_NUMBER / PUBLIC_BASE_URL en el .env"
    );
  }
  if (!client) client = twilio(config.twilio.accountSid, config.twilio.authToken);
  return client;
}

// Llama a un transportista. El callId viaja como query param del webhook HTTPS
// (eso sí está permitido) y de ahí se reinyecta como <Parameter> en el Stream,
// porque la URL wss:// del <Stream> NO admite query params.
export async function placeCall(opts: { callId: string; toNumber: string }) {
  const base = config.twilio.publicBaseUrl;
  const call = await twilioClient().calls.create({
    from: config.twilio.fromNumber,
    to: opts.toNumber,
    url: `${base}/twilio/outbound-twiml?callId=${encodeURIComponent(opts.callId)}`,
    statusCallback: `${base}/twilio/status?callId=${encodeURIComponent(opts.callId)}`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "answered", "completed"],
  });
  return call.sid;
}
