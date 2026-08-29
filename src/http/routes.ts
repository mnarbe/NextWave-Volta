// -----------------------------------------------------------------------------
// http/routes.ts
// The Express app: serves the test UI (public/index.html) and exposes the read
// endpoints used by the dashboard and for debugging.
// -----------------------------------------------------------------------------
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getCall } from "../store/calls.js";
import { getMandate } from "../store/mandates.js";
import { getAllNegotiations } from "../store/negotiations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/http/ -> project root -> public/
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");

export function createApp() {
  const app = express();
  app.use(express.json());
  // Serve the test UI from /public.
  app.use(express.static(PUBLIC_DIR));

  // Endpoint to inspect a call's state/log (handy for debugging).
  app.get("/calls/:id", (req, res) => {
    const call = getCall(req.params.id);
    if (!call) return res.status(404).json({ error: "not_found" });
    res.json(call);
  });

  // The mandate captured from the client (persisted to data/mandate.json). The
  // next phases (carrier negotiation) read it from here.
  app.get("/mandate", (_req, res) => {
    res.json(getMandate());
  });

  // Carrier negotiation state (for the dashboard). One record per carrier: what
  // they offered, conditions/delays, and the final decision.
  app.get("/negotiations", (_req, res) => {
    res.json(getAllNegotiations());
  });

  return app;
}
