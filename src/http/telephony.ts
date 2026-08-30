// -----------------------------------------------------------------------------
// http/telephony.ts
// Every HTTP surface related to the phone: the webhooks Twilio calls, and the
// control API the dashboard uses to dial and hang up.
// -----------------------------------------------------------------------------
import { Router, type Request, type Response, type NextFunction } from "express";
import twilioSdk from "twilio";

import { config, twilioReady, twilioMissing } from "../config.js";
import {
  streamTwiml,
  placeCall,
  hangup,
  configureAllNumbers,
  geoPermission,
  guessIso,
} from "../telephony/twilio.js";
import { resolveInboundParty, phaseFor } from "../telephony/routing.js";
import { localOnly } from "./local-only.js";

export const telephonyRoutes = Router();

// ---------------------------------------------------------------------------
// Webhooks (called by Twilio)
// ---------------------------------------------------------------------------

// Twilio signs every webhook. We verify the request really comes from them and
// not from anyone who found the tunnel URL.
function verifyTwilio(req: Request, res: Response, next: NextFunction) {
  if (!config.twilio.validateSignature || !config.twilio.authToken) return next();
  const signature = req.header("X-Twilio-Signature") || "";
  const url = `${config.publicUrl}${req.originalUrl}`;
  const ok = twilioSdk.validateRequest(config.twilio.authToken, signature, url, req.body);
  if (!ok) {
    console.warn(`[twilio] invalid signature on ${req.originalUrl}`);
    return res.status(403).type("text/plain").send("invalid signature");
  }
  next();
}

// INBOUND call to Volta's number. The same number serves both roles, so the
// first thing to work out is WHO is calling — see telephony/routing.ts. We
// answer with the TwiML that opens the media stream against /twilio/media.
telephonyRoutes.post("/twilio/voice", verifyTwilio, (req, res) => {
  const from = String(req.body?.From || "");
  const to = String(req.body?.To || "");
  // ?mode=... on the webhook URL forces a role, for testing.
  const forced = req.query.mode;
  const party =
    forced === "negotiate"
      ? "carrier"
      : forced === "intake"
        ? "provider"
        : resolveInboundParty(from, to);
  const mode = phaseFor(party);
  console.log(`[twilio] inbound ${from} -> ${to} | party=${party} mode=${mode}`);
  res.type("text/xml").send(streamTwiml({ mode, peer: from }));
});

// Call lifecycle (initiated / ringing / answered / completed).
telephonyRoutes.post("/twilio/status", verifyTwilio, (req, res) => {
  console.log(
    `[twilio] ${req.body?.CallSid} ${req.body?.CallStatus}` +
      (req.body?.ErrorCode ? ` error=${req.body.ErrorCode}` : "")
  );
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// Control (used by the dashboard)
// ---------------------------------------------------------------------------

// Heartbeat, so the tunnel can be checked from the outside.
telephonyRoutes.get("/twilio/ping", (_req, res) => res.type("text/plain").send("pong"));

// Is the tunnel alive? We hit ourselves over the PUBLIC URL: the same path
// Twilio takes. If the tunnel is down, inbound calls die with "an application
// error has occurred" and without this you find out during the demo.
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

// Is the phone ready? Shows what is missing and which URLs are in play.
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

// Points the number at this machine (same as editing it in the console).
telephonyRoutes.post("/twilio/setup", localOnly, async (_req, res) => {
  try {
    res.json(await configureAllNumbers());
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Volta CALLS someone. Defaults to negotiation mode (the carrier case).
//   curl -X POST localhost:3000/call -H 'content-type: application/json' \
//        -d '{"to":"+5215512345678","carrier":"Transportes del Pacifico"}'
telephonyRoutes.post("/call", localOnly, async (req, res) => {
  const to = String(req.body?.to || "").trim();
  if (!/^\+[1-9]\d{6,15}$/.test(to)) {
    return res.status(400).json({ error: "to must be E.164, e.g. +5215512345678" });
  }
  // Dialling one of our own numbers makes Volta call itself: the outbound call
  // hits our own inbound webhook, a second Volta session answers, and the two
  // agents talk to each other. Put the human's phone here, not Volta's number.
  const ours = [config.twilio.number, config.twilio.carrierNumber].filter(Boolean);
  if (ours.some((n) => n.replace(/[^\d+]/g, "") === to.replace(/[^\d+]/g, ""))) {
    return res.status(400).json({
      error:
        `${to} is Volta's own number — calling it would just make Volta talk to ` +
        `itself. Dial the person's phone instead.`,
    });
  }
  const mode = req.body?.mode === "intake" ? "intake" : "negotiate";

  // {"dryRun": true} answers with the TwiML we WOULD send, without dialling.
  // Handy to check which script a call is about to run without spending one.
  if (req.body?.dryRun) {
    return res.json({
      dryRun: true,
      to,
      mode,
      twiml: streamTwiml({ mode, carrier: req.body?.carrier, peer: to }),
    });
  }

  try {
    const call = await placeCall({ to, mode, carrier: req.body?.carrier });
    console.log(`[twilio] calling ${to} (mode=${mode}) sid=${call.sid}`);
    res.json(call);
  } catch (err: any) {
    // 21215 = country not enabled in Voice Dialing Permissions.
    res.status(400).json({ error: err.message, code: err.code });
  }
});

telephonyRoutes.post("/call/:sid/hangup", localOnly, async (req, res) => {
  try {
    await hangup(req.params.sid);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Does Twilio let us call this country? (Mexico is blocked by default.)
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
