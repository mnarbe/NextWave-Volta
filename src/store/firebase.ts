// -----------------------------------------------------------------------------
// store/firebase.ts
// Mirrors the end-of-call artefacts to Cloud Firestore:
//   - the final carrier negotiation record (end_negotiation), and
//   - the mandate captured from the client (end_intake / set_negotiation_mandate).
//
// Firebase is OPTIONAL. Without credentials the server still runs; these calls
// just do nothing. The local data/*.json files stay the source of truth — the
// Firestore write is best-effort and fire-and-forget, so it never blocks a call
// or breaks the synchronous store contract.
// -----------------------------------------------------------------------------
import fs from "node:fs";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

import type { CarrierNegotiation, NegotiationMandate } from "../domain/types.js";

// Collections in Firestore.
const NEGOTIATIONS = "negotiations";
const MANDATES = "mandates";

// null once we know Firebase isn't configured (so we only warn once).
let cached: Firestore | null | undefined;

// Parse the service account from either an inline JSON string
// (FIREBASE_SERVICE_ACCOUNT) or a path to the key file
// (FIREBASE_SERVICE_ACCOUNT_PATH / GOOGLE_APPLICATION_CREDENTIALS).
function loadServiceAccount(): Record<string, unknown> | null {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch {
      console.warn("[firebase] FIREBASE_SERVICE_ACCOUNT is not valid JSON — skipping export.");
      return null;
    }
  }

  const file =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim() ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (file) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      console.warn(`[firebase] could not read service account at ${file} — skipping export.`);
      return null;
    }
  }

  return null;
}

// Lazily bring up the Firestore client. Returns null (once) if unconfigured or
// if init failed, so callers can no-op quietly.
function db(): Firestore | null {
  if (cached !== undefined) return cached;

  const serviceAccount = loadServiceAccount();
  if (!serviceAccount) {
    console.warn(
      "[firebase] no service account configured (FIREBASE_SERVICE_ACCOUNT[_PATH]) — call export disabled."
    );
    cached = null;
    return cached;
  }

  try {
    const app: App =
      getApps()[0] ??
      initializeApp({
        credential: cert(serviceAccount as Parameters<typeof cert>[0]),
        projectId:
          process.env.FIREBASE_PROJECT_ID?.trim() ||
          (serviceAccount.project_id as string | undefined),
      });
    const store = getFirestore(app);
    // The records carry optional fields; let Firestore drop the undefined ones.
    store.settings({ ignoreUndefinedProperties: true });
    cached = store;
  } catch (err) {
    console.warn("[firebase] init failed — call export disabled:", err);
    cached = null;
  }
  return cached;
}

// Fire-and-forget: run the write, swallow (log) any failure. Never awaited by
// the stores.
function send(label: string, run: (store: Firestore) => Promise<unknown>): void {
  const store = db();
  if (!store) return;
  Promise.resolve()
    .then(() => run(store))
    .catch((err) => console.warn(`[firebase] ${label} export failed:`, err));
}

// End of a carrier call: push the full negotiation record, keyed by callId so a
// re-finalize overwrites rather than duplicates.
export function exportNegotiation(record: CarrierNegotiation): void {
  send(`negotiation ${record.callId.slice(0, 8)}`, (store) =>
    store
      .collection(NEGOTIATIONS)
      .doc(record.callId)
      .set({ ...record, exportedAt: new Date().toISOString() }, { merge: true })
  );
}

// End of an intake call: append the captured mandate (auto-id keeps the history
// of every capture).
export function exportMandate(mandate: NegotiationMandate): void {
  send("mandate", (store) =>
    store
      .collection(MANDATES)
      .add({ ...mandate, exportedAt: new Date().toISOString() })
  );
}
