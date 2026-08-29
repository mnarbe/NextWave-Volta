// -----------------------------------------------------------------------------
// routes/telephony.ts
// Todo lo HTTP que tiene que ver con el teléfono: los webhooks que llama Twilio
// y la API de control que usa el dashboard para marcar y colgar.
// Dueño: llamada.
// -----------------------------------------------------------------------------
import { Router, type Request, type Response, type NextFunction } from "express";
import twilioSdk from "twilio";

import { config, twilioReady, twilioMissing } from "../config.js";
import {
  streamTwiml,
  placeCall,
  hangup,
  configureNumber,
  geoPermission,
  guessIso,
} from "../voice/twilio.js";

export const telephonyRoutes = Router();

// ---------------------------------------------------------------------------
// Webhooks (los llama Twilio)
// ---------------------------------------------------------------------------

// Twilio firma cada webhook. Verificamos que el request venga de verdad de
// ellos y no de cualquiera que descubrió la URL del túnel.
function verifyTwilio(req: Request, res: Response, next: NextFunction) {
  if (!config.twilio.validateSignature || !config.twilio.authToken) return next();
  const signature = req.header("X-Twilio-Signature") || "";
  const url = `${config.publicUrl}${req.originalUrl}`;
  const ok = twilioSdk.validateRequest(config.twilio.authToken, signature, url, req.body);
  if (!ok) {
    console.warn(`[twilio] firma inválida en ${req.originalUrl}`);
    return res.status(403).type("text/plain").send("invalid signature");
  }
  next();
}

// Llamada ENTRANTE al número de Volta: el cliente marca y cae acá. Respondemos
// el TwiML que abre el media stream contra /twilio/media.
telephonyRoutes.post("/twilio/voice", verifyTwilio, (req, res) => {
  // ?mode=negotiate en la URL del webhook si querés que las entrantes negocien.
  const mode = req.query.mode === "negotiate" ? "negotiate" : "intake";
  console.log(`[twilio] llamada entrante de ${req.body?.From} (mode=${mode})`);
  res.type("text/xml").send(streamTwiml({ mode }));
});

// Ciclo de vida de la llamada (initiated / ringing / answered / completed).
telephonyRoutes.post("/twilio/status", verifyTwilio, (req, res) => {
  console.log(
    `[twilio] ${req.body?.CallSid} ${req.body?.CallStatus}` +
      (req.body?.ErrorCode ? ` error=${req.body.ErrorCode}` : "")
  );
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// Control (lo usa el dashboard)
// ---------------------------------------------------------------------------

// Latido para chequear el túnel desde afuera.
telephonyRoutes.get("/twilio/ping", (_req, res) => res.type("text/plain").send("pong"));

// ¿El túnel está vivo? Nos pegamos a nosotros mismos por la URL PÚBLICA: es el
// mismo camino que hace Twilio. Si el túnel se cayó, la llamada entrante muere
// con "an application error has occurred" y sin esto no te enterás hasta la demo.
async function tunnelUp(): Promise<boolean> {
  if (!config.publicUrl) return false;
  try {
    const res = await fetch(`${config.publicUrl}/twilio/ping`, {
      signal: AbortSignal.timeout(4000),
    });
    return res.ok && (await res.text()) === "pong";
  } catch {
    return false;
  }
}

// ¿Está todo listo para telefonear? Muestra qué falta y con qué URLs quedó.
telephonyRoutes.get("/twilio/health", async (_req, res) => {
  const tunnel = await tunnelUp();
  res.json({
    ready: twilioReady() && tunnel,
    missing: twilioMissing(),
    tunnel: tunnel ? "ok" : "down",
    number: config.twilio.number || null,
    publicUrl: config.publicUrl || null,
    voiceWebhook: config.publicUrl ? `${config.publicUrl}/twilio/voice` : null,
    streamUrl: config.publicWsUrl ? `${config.publicWsUrl}/twilio/media` : null,
  });
});

// Deja el número apuntando a esta máquina (equivale a editarlo en la consola).
telephonyRoutes.post("/twilio/setup", async (_req, res) => {
  try {
    res.json(await configureNumber());
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Volta LLAMA a alguien. Por defecto en modo negociación (el caso del carrier).
//   curl -X POST localhost:3000/call -H 'content-type: application/json' \
//        -d '{"to":"+5215512345678","carrier":"Transportes del Pacífico"}'
telephonyRoutes.post("/call", async (req, res) => {
  const to = String(req.body?.to || "").trim();
  if (!/^\+[1-9]\d{6,15}$/.test(to)) {
    return res.status(400).json({ error: "to debe ser E.164, ej +5215512345678" });
  }
  const mode = req.body?.mode === "intake" ? "intake" : "negotiate";
  try {
    const call = await placeCall({ to, mode, carrier: req.body?.carrier });
    console.log(`[twilio] llamando a ${to} (mode=${mode}) sid=${call.sid}`);
    res.json(call);
  } catch (err: any) {
    // 21215 = país no habilitado en Voice Dialing Permissions.
    res.status(400).json({ error: err.message, code: err.code });
  }
});

telephonyRoutes.post("/call/:sid/hangup", async (req, res) => {
  try {
    await hangup(req.params.sid);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ¿Twilio nos deja llamar a este país? (México viene bloqueado por defecto.)
telephonyRoutes.get("/twilio/geo/:iso", async (req, res) => {
  try {
    res.json(await geoPermission(req.params.iso));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

telephonyRoutes.get("/twilio/geo", async (req, res) => {
  try {
    res.json(await geoPermission(guessIso(String(req.query.to || ""))));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
