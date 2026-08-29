// -----------------------------------------------------------------------------
// twilio/routes.ts
// Webhooks de Twilio + el disparador de llamadas salientes.
//
// OJO: Twilio postea application/x-www-form-urlencoded, no JSON. server.ts monta
// express.json(), que no parsea eso, así que este router monta lo suyo.
// -----------------------------------------------------------------------------
import express from "express";
import twilio from "twilio";

import { config, wsBaseUrl } from "../config.js";
import { createCall, log } from "../store.js";
import { getMandate } from "../mandateStore.js";
import { negotiationMandate } from "../mandate.js";
import { placeCall } from "./client.js";

const MEDIA_PATH = "/twilio/media";

// TwiML: conectá esta llamada a nuestro WebSocket y pasale el callId.
// <Connect><Stream> es bidireccional; la URL wss no admite query params, por eso
// el callId va como <Parameter>.
function streamTwiml(callId: string, mode: "intake" | "negotiate"): string {
  const res = new twilio.twiml.VoiceResponse();
  const connect = res.connect();
  const stream = connect.stream({ url: `${wsBaseUrl()}${MEDIA_PATH}` });
  stream.parameter({ name: "callId", value: callId });
  stream.parameter({ name: "mode", value: mode });
  return res.toString();
}

export function twilioRouter(): express.Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  // Validación de firma. Apagada por defecto: detrás de ngrok/proxies el host y
  // el protocolo que ve Express no siempre coinciden con los que firmó Twilio, y
  // eso rompe llamadas en vivo. Encendela con TWILIO_VALIDATE_SIGNATURE=true.
  if (process.env.TWILIO_VALIDATE_SIGNATURE === "true") {
    router.use(
      twilio.webhook({ validate: true, authToken: config.twilio.authToken })
    );
  }

  // --- SALIENTE: Volta llama a un transportista ------------------------------
  router.all("/twilio/outbound-twiml", (req, res) => {
    const callId = String(req.query.callId || "");
    res.type("text/xml").send(streamTwiml(callId, "negotiate"));
  });

  // --- ENTRANTE: alguien llama al número de Volta ----------------------------
  // Sin mandato guardado => es el cliente/jurado trayendo el encargo (intake).
  // Con mandato guardado => es un transportista/chofer (negociación).
  router.post("/twilio/inbound", (req, res) => {
    const captured = getMandate();
    const mode: "intake" | "negotiate" = captured ? "negotiate" : "intake";
    const mandate = mode === "negotiate" ? negotiationMandate(captured).mandate : null;

    const callId = createCall(mandate);
    log(callId, "call_started", {
      side: "twilio_inbound",
      from: req.body?.From,
      callSid: req.body?.CallSid,
      mode,
    });
    res.type("text/xml").send(streamTwiml(callId, mode));
  });

  // --- Ciclo de vida de la llamada ------------------------------------------
  router.post("/twilio/status", (req, res) => {
    const callId = String(req.query.callId || "");
    if (callId) {
      log(callId, "call_status", {
        status: req.body?.CallStatus,
        callSid: req.body?.CallSid,
        duration: req.body?.CallDuration,
      });
    }
    res.sendStatus(204);
  });

  // --- Disparador: arrancá una negociación saliente --------------------------
  // POST /calls/outbound  { "to": "+52..." }
  router.post("/calls/outbound", express.json(), async (req, res) => {
    const to = String(req.body?.to || "").trim();
    if (!to) return res.status(400).json({ error: "missing_to" });

    const { mandate, source } = negotiationMandate(getMandate());
    const callId = createCall(mandate);

    try {
      const callSid = await placeCall({ callId, toNumber: to });
      log(callId, "call_started", { side: "twilio_outbound", to, callSid, mandateSource: source });
      res.json({ callId, callSid, to, mandateSource: source, mandate });
    } catch (err: any) {
      log(callId, "error", { where: "place_call", err: String(err?.message || err) });
      res.status(502).json({ error: "place_call_failed", detail: String(err?.message || err) });
    }
  });

  return router;
}

export { MEDIA_PATH };
