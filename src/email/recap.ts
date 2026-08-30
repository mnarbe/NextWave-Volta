// -----------------------------------------------------------------------------
// email/recap.ts
// The written recap that turns a spoken agreement into a commitment on record.
//
// Two bars, and they are different:
//   1. RECAP OUT  — the challenge's rule: a commitment only counts once the
//      written recap has actually been sent. That is `recap.status === "sent"`.
//   2. CONFIRMED  — what Volta promises out loud: the mail goes to both sides
//      with a link each has to click, and the booking is not final until they
//      do. That is one confirmation per party.
//
// Both sides get their own mail and their own link. In the demo they land in the
// same inbox (RECAP_EMAIL), which is also what you want on stage: two mails
// arrive, one addressed to the client and one to the carrier.
//
// The link is signed rather than stored: an HMAC of commitment + party, so a
// token cannot be forged and nothing secret has to live on the commitment
// (which is served whole by GET /calls/:id).
// -----------------------------------------------------------------------------
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { config } from "../config.js";
import { sendEmail, emailReady } from "./resend.js";
import type { Commitment, CommitmentRecap, Mandate } from "../domain/types.js";
import { findCarrierProfileByName } from "../intelligence/carrier-profiles.js";

export type Party = "client" | "carrier";

// Stable across restarts if you set it; otherwise links die with the process,
// which is fine for a demo and safe by default.
const SECRET = process.env.CONFIRM_SECRET || randomBytes(32).toString("hex");

function recipient(party: Party): string {
  const fallback = (process.env.RECAP_EMAIL || "").trim();
  const specific =
    party === "client"
      ? (process.env.RECAP_CLIENT_EMAIL || "").trim()
      : (process.env.RECAP_CARRIER_EMAIL || "").trim();
  return specific || fallback;
}

export function confirmToken(commitmentId: string, party: Party): string {
  return createHmac("sha256", SECRET).update(`${commitmentId}:${party}`).digest("hex").slice(0, 32);
}

export function verifyConfirmToken(
  commitmentId: string,
  party: Party,
  token: string
): boolean {
  const expected = Buffer.from(confirmToken(commitmentId, party));
  const given = Buffer.from(String(token || ""));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function confirmUrl(commitmentId: string, party: Party): string {
  const base = config.publicUrl || `http://localhost:${config.port}`;
  return `${base}/confirm/${commitmentId}/${party}?t=${confirmToken(commitmentId, party)}`;
}

const money = (n: number) => `$${n.toLocaleString("en-US")} MXN`;

function pickup(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" });
}

function intelligenceBlock(c: Commitment, party: Party) {
  // Only the client gets carrier history. It is context before their approval,
  // not a term the carrier needs to receive in their confirmation mail.
  if (party !== "client") return { text: "", html: "" };
  const profile = findCarrierProfileByName(c.agreedByName);
  if (!profile) return { text: "", html: "" };

  const booked = profile.sample.bookedJobs;
  const changes = profile.stability;
  const median =
    profile.pricing.medianFinalPriceMxn == null
      ? "Not enough price data"
      : money(profile.pricing.medianFinalPriceMxn);
  const text = [
    "Carrier intelligence (informational)",
    `Historical demo sample: ${profile.sample.seededDemoJobs} jobs.`,
    `Median booked price: ${median}.`,
    `Post-booking changes: ${changes.postBookingChanges}/${booked} booked jobs.`,
    `Pickup changes after booking: ${changes.pickupChanges}/${booked} booked jobs.`,
    `Price-increase requests after booking: ${changes.priceIncreaseRequests}/${booked} booked jobs.`,
    "This profile is additional context only. Today's selection was based on the current offer and your mandate.",
  ].join("\n");

  const html = `
  <div style="border:1px solid #cdd7ee;background:#f6f8ff;border-radius:8px;padding:14px 16px;margin:20px 0;font-size:14px;line-height:1.5">
    <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#4f5d7a;margin-bottom:6px">Carrier intelligence</div>
    <p style="margin:0 0 8px;font-weight:600">Historical demo sample: ${profile.sample.seededDemoJobs} jobs</p>
    <ul style="margin:0;padding-left:18px">
      <li>Median booked price: ${median}</li>
      <li>Post-booking changes: ${changes.postBookingChanges}/${booked} booked jobs</li>
      <li>Pickup changes after booking: ${changes.pickupChanges}/${booked} booked jobs</li>
      <li>Price-increase requests after booking: ${changes.priceIncreaseRequests}/${booked} booked jobs</li>
    </ul>
    <p style="font-size:12px;color:#56617a;margin:10px 0 0">This profile is additional context only. Today's selection was based on the current offer and your mandate.</p>
  </div>`;

  return { text, html };
}

export function buildRecapBody(c: Commitment, m: Mandate | null, party: Party) {
  const other = party === "client" ? "the carrier" : "the client";
  const rows: Array<[string, string]> = [
    ["Price", money(c.priceMxn)],
    ["Pickup", pickup(c.pickupTime)],
  ];
  if (m?.origin) rows.push(["Origin", m.origin]);
  if (m?.destination) rows.push(["Destination", m.destination]);
  if (m?.containerNumber) rows.push(["Container", m.containerNumber]);
  if (c.agreedByName) rows.push(["Agreed with", c.agreedByName]);
  if (c.conditions.length) rows.push(["Conditions", c.conditions.join(", ")]);

  const url = confirmUrl(c.id, party);
  const intelligence = intelligenceBlock(c, party);

  const text = [
    `Volta — confirmation of what was agreed on the call`,
    ``,
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ``,
    ...(intelligence.text ? [intelligence.text, ``] : []),
    `This booking is not final until both sides confirm.`,
    `Confirm here: ${url}`,
    ``,
    `We are also waiting on ${other}.`,
    `Reference: ${c.id}`,
  ].join("\n");

  const html = `
<div style="font-family:ui-sans-serif,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
  <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#666;margin:0 0 4px">Volta</p>
  <h1 style="font-size:20px;margin:0 0 16px">Confirmation of what was agreed on the call</h1>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    ${rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:8px 0;color:#666;width:130px">${k}</td><td style="padding:8px 0;font-weight:600">${v}</td></tr>`
      )
      .join("")}
  </table>
  ${intelligence.html}
  <p style="font-size:14px;margin:20px 0 12px">
    This booking is <strong>not final</strong> until both sides confirm. We are also waiting on ${other}.
  </p>
  <p style="margin:0 0 20px">
    <a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;font-size:14px">Confirm this booking</a>
  </p>
  <p style="font-size:12px;color:#888;margin:0">Reference: ${c.id}</p>
</div>`.trim();

  return { text, html };
}

// Sends both recaps. Returns what actually happened — the caller decides whether
// the commitment counts, so this never pretends to have sent something.
export async function sendRecap(
  commitment: Commitment,
  mandate: Mandate | null
): Promise<CommitmentRecap> {
  const sentAt = new Date().toISOString();

  if (!emailReady()) {
    return { status: "failed", sentAt, messageIds: [], to: [], error: "email_not_configured" };
  }

  const parties: Party[] = ["client", "carrier"];
  const targets = parties.map((p) => ({ party: p, to: recipient(p) }));
  const missing = targets.filter((t) => !t.to);
  if (missing.length) {
    return { status: "failed", sentAt, messageIds: [], to: [], error: "no_recipient_configured" };
  }

  const results = await Promise.all(
    targets.map(async ({ party, to }) => {
      const { text, html } = buildRecapBody(commitment, mandate, party);
      const subject = `Booking confirmation — ${money(commitment.priceMxn)}, pickup ${pickup(
        commitment.pickupTime
      )}`;
      return { party, to, res: await sendEmail({ to, subject, html, text }) };
    })
  );

  const failed = results.filter((r) => !r.res.ok);
  return {
    // Both have to be out: a recap that only reached one side is not the recap
    // Volta described on the call.
    status: failed.length ? "failed" : "sent",
    sentAt,
    messageIds: results.flatMap((r) => (r.res.ok ? [r.res.id] : [])),
    to: results.map((r) => r.to),
    error: failed.length
      ? failed.map((f) => `${f.party}: ${(f.res as any).error}`).join("; ")
      : undefined,
  };
}
