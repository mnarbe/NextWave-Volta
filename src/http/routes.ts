// -----------------------------------------------------------------------------
// http/routes.ts
// The Express app: serves the dashboard (public/) and exposes the read
// endpoints used by it and for debugging. The phone endpoints live in
// http/telephony.ts and are mounted here.
// -----------------------------------------------------------------------------
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getCall, findCommitment, log } from "../store/calls.js";
import { verifyConfirmToken } from "../email/recap.js";
import { commitmentState } from "../domain/types.js";
import { getMandate } from "../store/mandates.js";
import { getAllNegotiations } from "../store/negotiations.js";
import { listCarrierProfiles } from "../intelligence/carrier-profiles.js";
import { telephonyRoutes } from "./telephony.js";
import { roundRoutes } from "./round.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/http/ -> project root -> public/
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

export function createApp() {
  const app = express();
  app.use(express.json());
  // Twilio webhooks arrive as form-urlencoded.
  app.use(express.urlencoded({ extended: false }));
  // Serve the dashboard from /public.
  app.use(express.static(PUBLIC_DIR));

  // Endpoint to inspect a call's state/log (handy for debugging).
  app.get("/calls/:id", (req, res) => {
    const call = getCall(req.params.id);
    if (!call) return res.status(404).json({ error: "not_found" });
    res.json(call);
  });

  // The mandate captured from the client (persisted to data/mandate.json). The
  // next phases (carrier negotiation) read it from here.
  // SYNC-READ: getMandate() reads without awaiting.
  app.get("/mandate", (_req, res) => {
    res.json(getMandate());
  });

  // Carrier negotiation state (for the dashboard). One record per carrier: what
  // they offered, conditions/delays, and the final decision.
  // SYNC-READ: same.
  app.get("/negotiations", (_req, res) => {
    res.json(getAllNegotiations());
  });

  // Read-only carrier intelligence for the dashboard. This is intentionally
  // separate from the negotiation path: profiles inform people, never Volta's
  // ranking, prompts, mandate checks, or call behavior.
  app.get("/carrier-profiles", (_req, res) => {
    res.json(listCarrierProfiles());
  });

  // The link from the recap email. Volta promises on the call that the booking
  // is not final until both sides click theirs — this is where that becomes
  // true. GET, because it is opened from a mail client.
  app.get("/confirm/:id/:party", (req, res) => {
    const { id, party } = req.params;
    const send = (code: number, title: string, detail: string) =>
      res.status(code).type("html").send(page(title, detail));

    if (party !== "client" && party !== "carrier") {
      return send(400, "Invalid link", "That confirmation link is not valid.");
    }
    if (!verifyConfirmToken(id, party, String(req.query.t || ""))) {
      return send(403, "Invalid link", "This link could not be verified. Ask for a new confirmation email.");
    }

    const found = findCommitment(id);
    if (!found) {
      return send(404, "Not found", "We could not find that booking. It may have expired with a restart.");
    }

    const { call, commitment } = found;
    const already = commitment.confirmations.some((c) => c.party === party);
    if (!already) {
      commitment.confirmations.push({ party, at: new Date().toISOString() });
      log(call.callId, "tool_result", { name: "commitment_confirmed", commitmentId: id, party });
    }

    const state = commitmentState(commitment);
    const waitingOn = party === "client" ? "the carrier" : "the client";
    return send(
      200,
      state === "confirmed" ? "Booking confirmed" : "Thanks — got it",
      state === "confirmed"
        ? "Both sides have confirmed. This booking is final."
        : `Your confirmation is recorded. We are still waiting on ${waitingOn}.`
    );
  });

  // Phone: Twilio webhooks + control API (/call, /twilio/health, ...).
  app.use(telephonyRoutes);

  // Parallel carrier round: /round/start, /round.
  app.use(roundRoutes);

  return app;
}

// Minimal confirmation page — opened from a mail client, often on a phone.
function page(title: string, detail: string): string {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Volta</title>
<div style="font-family:ui-sans-serif,system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 24px;text-align:center;color:#111">
  <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#666;margin:0 0 8px">Volta</p>
  <h1 style="font-size:22px;margin:0 0 12px">${title}</h1>
  <p style="font-size:15px;line-height:1.5;color:#444;margin:0">${detail}</p>
</div>`;
}
