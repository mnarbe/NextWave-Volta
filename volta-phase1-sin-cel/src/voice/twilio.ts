// -----------------------------------------------------------------------------
// twilio.ts
// Todo lo que le pedimos a Twilio por REST/TwiML:
//   - el TwiML que abre el Media Stream bidireccional contra nuestro WSS,
//   - llamadas SALIENTES (Volta llama al carrier),
//   - apuntar el webhook del número a esta máquina (para no tocar la consola),
//   - colgar una llamada.
//
// El audio NO pasa por acá: eso es twilioStream.ts.
// -----------------------------------------------------------------------------
import twilioSdk from "twilio";
import { config, twilioReady, twilioMissing } from "../config.js";

let client: ReturnType<typeof twilioSdk> | null = null;

export function twilioClient() {
  if (!twilioReady()) {
    throw new Error(`Twilio no configurado. Falta: ${twilioMissing().join(", ")}`);
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
  // "intake" = hablar con el cliente/jurado. "negotiate" = negociar con carrier.
  mode: "intake" | "negotiate";
  // Nombre del carrier, si lo sabemos de antemano (solo para la UI).
  carrier?: string;
};

// La URL WSS que Twilio abre contra nosotros, con el modo en la query.
export function streamUrl(params: StreamParams): string {
  const q = new URLSearchParams({ mode: params.mode });
  if (params.carrier) q.set("carrier", params.carrier);
  return `${config.publicWsUrl}/twilio/media?${q.toString()}`;
}

// <Connect><Stream> es el modo BIDIRECCIONAL: Twilio nos manda el audio del
// interlocutor y reproduce el que le devolvemos. (<Start><Stream> sería solo
// escuchar.) Cuando cerramos el WebSocket, se termina el <Connect> y, como no
// hay más TwiML después, Twilio cuelga.
export function streamTwiml(params: StreamParams): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Connect><Stream url="${xmlEscape(streamUrl(params))}"/></Connect></Response>`
  );
}

// Llamada SALIENTE: Volta marca al carrier. El TwiML va inline (parámetro
// `twiml`), así no hace falta un segundo webhook para las salientes.
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

// Deja el número apuntando a ESTA máquina (voiceUrl -> /twilio/voice). Es lo
// que evita entrar a la consola de Twilio a mano cada vez que cambia la URL
// pública.
export async function configureNumber() {
  const c = twilioClient();
  const [number] = await c.incomingPhoneNumbers.list({
    phoneNumber: config.twilio.number,
    limit: 1,
  });
  if (!number) {
    throw new Error(
      `El número ${config.twilio.number} no está en esta cuenta de Twilio.`
    );
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

// ¿Podemos llamar a este país? Twilio bloquea por defecto buena parte del
// mundo (Voice Dialing Permissions). Si el carrier es +52 (México) o +54
// (Argentina) y no está habilitado, la llamada falla con error 13227/21215.
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

// De "+5215512345678" a "MX" no se puede sin tabla; usamos los prefijos que
// nos importan para el demo y caemos a US por defecto.
export function guessIso(e164: string): string {
  const n = e164.replace(/[^\d+]/g, "");
  if (n.startsWith("+52")) return "MX";
  if (n.startsWith("+54")) return "AR";
  if (n.startsWith("+55")) return "BR";
  if (n.startsWith("+34")) return "ES";
  if (n.startsWith("+1")) return "US";
  return "US";
}
