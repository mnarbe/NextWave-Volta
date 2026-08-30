// ============================================================================
// render.js — EVERYTHING that draws on screen.
// Owner: design.
//
// This is the only file that touches the DOM. It knows nothing about
// WebSockets, Twilio or audio: it takes already-chewed data and paints it. If
// you want to change how a card, a badge or a panel looks, it is all here (and
// in styles.css).
//
// The contract with client.js is the exported functions below. As long as they
// keep existing with the same names, you can rewrite the insides entirely
// without breaking anyone.
// ============================================================================

// The page's elements. client.js uses these to listen for clicks and read the
// inputs; everything else it draws goes through the functions in this file.
export const ui = {
  dot: document.getElementById("dot"),
  roundBtn: document.getElementById("roundBtn"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  forceCutBtn: document.getElementById("forceCutBtn"),
  answerBtn: document.getElementById("answerBtn"),
  carrierNum: document.getElementById("carrierNum"),
  carrierName: document.getElementById("carrierName"),
  callBtn: document.getElementById("callBtn"),
  hangBtn: document.getElementById("hangBtn"),
};

const phaseChip = document.getElementById("phaseChip");
const hintEl = document.getElementById("hintEl");
const incoming = document.getElementById("incoming");
const convo = document.getElementById("convo");
const toolsEl = document.getElementById("tools");
const mandateCard = document.getElementById("mandateCard");
const mPrice = document.getElementById("mPrice");
const mFields = document.getElementById("mFields");
const mStatus = document.getElementById("mStatus");
const carriersEl = document.getElementById("carriers");
const decisionEl = document.getElementById("decision");
const phoneNum = document.getElementById("phoneNum");
const phoneState = document.getElementById("phoneState");

let mandateCap = null; // the client's price cap, to compare offers against

export function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// --- overall screen state ----------------------------------------------------

// Green dot: we have a connection to the backend.
export function setConnected(on) {
  ui.dot.classList.toggle("on", Boolean(on));
}

export function setHint(text) {
  hintEl.textContent = text;
}

// phase: "idle" | "intake" | "negotiate"
export function setPhase(p) {
  if (p === "intake") {
    phaseChip.hidden = false;
    phaseChip.className = "chip";
    phaseChip.textContent = "intake · client";
    hintEl.textContent = "Volta is taking the job and the maximum price.";
  } else if (p === "negotiate") {
    phaseChip.hidden = false;
    phaseChip.className = "chip negotiate";
    phaseChip.textContent = "negotiation · carrier";
    hintEl.textContent = "Volta wants a lower price; two refusals and it closes.";
  } else {
    phaseChip.hidden = true;
  }
}

// Refusal counter on the phase chip.
export function setRefusals(n) {
  if (n) phaseChip.textContent = `negotiation · refusals ${n}/2`;
}

// --- phone bar ---------------------------------------------------------------
export function setPhoneNumber(text) {
  phoneNum.textContent = text;
}

// kind: "" (neutral) | "live" (green) | "err" (red)
export function setPhoneState(text, kind) {
  phoneState.textContent = text;
  phoneState.className = "phone-state" + (kind ? " " + kind : "");
}

export function setCallButtonEnabled(on) {
  ui.callBtn.disabled = !on;
}

export function setHangupVisible(on) {
  ui.hangBtn.hidden = !on;
}

// --- conversation and backend activity ---------------------------------------
export function addMessage(who, text) {
  const d = document.createElement("div");
  d.className = "msg " + (who === "user" ? "user" : "agent");
  d.innerHTML = `<div class="who">${who === "user" ? "Other party" : "Volta"}</div>${escapeHtml(text)}`;
  convo.appendChild(d);
  convo.scrollTop = convo.scrollHeight;
}

export function addTool(kind, data) {
  const d = document.createElement("div");
  d.className = "tool";
  if (kind === "tool_call") {
    d.innerHTML = `<span class="name">→ ${data.name}</span><pre>${escapeHtml(JSON.stringify(data.args, null, 2))}</pre>`;
  } else if (kind === "tool_result") {
    const decision = data.result && data.result.decision;
    const badge = decision ? `<span class="badge ${decision}">${decision}</span>` : "";
    d.innerHTML = `<span class="name">← ${data.name}</span>${badge}<pre>${escapeHtml(JSON.stringify(data.result, null, 2))}</pre>`;
  } else if (kind === "barge_in") {
    d.innerHTML = `<span class="name">⚡ barge-in</span> (the agent was interrupted)`;
  } else if (kind === "error") {
    d.innerHTML = `<span class="name" style="color:#ff8f9c">error</span><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
  }
  toolsEl.appendChild(d);
  toolsEl.scrollTop = toolsEl.scrollHeight;
}

// --- captured mandate panel --------------------------------------------------
export function renderMandate(m, opts = {}) {
  if (!m) return;
  mandateCard.classList.remove("empty");
  if (opts.justCaptured) mandateCard.classList.add("captured");
  mPrice.textContent =
    m.maxPriceMxn != null ? Number(m.maxPriceMxn).toLocaleString("en-US") : "—";
  const rows = [
    ["Origin", m.origin],
    ["Destination", m.destination],
    ["Container", m.containerNumber],
    ["Pickup from", m.pickupWindowStart],
    ["Pickup until", m.pickupWindowEnd],
    ["Forbidden conditions", (m.forbiddenConditions || []).join(", ")],
    ["Notes", m.notes],
  ].filter(([, v]) => v);
  mFields.innerHTML = rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join("");
  const when = m.capturedAt ? new Date(m.capturedAt).toLocaleTimeString() : "";
  mStatus.textContent = "Mandate saved" + (when ? " · " + when : "");
  mandateCap = m.maxPriceMxn != null ? Number(m.maxPriceMxn) : mandateCap;
}

export function setMandateDone(text) {
  mStatus.textContent = text;
  mStatus.classList.add("done");
}

// --- carrier negotiation panel -----------------------------------------------
const negs = new Map(); // callId -> negotiation record

function fmtMxn(n) {
  return n != null ? "$" + Number(n).toLocaleString("en-US") : "—";
}

function delayBadge(days, note) {
  if (days == null && !note) return "";
  if (days === 0 && !note) return `<span class="delay none">in window</span>`;
  const label = days > 0 ? `+${days} day${days === 1 ? "" : "s"}` : (note ? "delay" : "");
  return `<span class="delay">⏱ ${escapeHtml(label)}${note ? " · " + escapeHtml(note) : ""}</span>`;
}

function capVs(price) {
  if (price == null || mandateCap == null) return "";
  const cls = price <= mandateCap ? "under" : "over";
  const rel = price <= mandateCap ? "within cap" : "OVER cap";
  return `<span class="vs ${cls}">${rel} (${fmtMxn(mandateCap)})</span>`;
}

function carrierCard(c) {
  const L = c.latest || { conditions: [] };
  const name = c.carrierName
    ? escapeHtml(c.carrierName)
    : `<span class="anon">Carrier (unnamed)</span>`;
  const status = c.status || "in_progress";
  const statusLabel = { in_progress: "in progress", deal: "deal", no_deal: "no deal" }[status];
  const conds = (L.conditions || [])
    .map((x) => `<span class="cond-chip">${escapeHtml(x)}</span>`)
    .join("");
  const rows = [];
  if (L.pickupTime) rows.push(["Pickup", escapeHtml(L.pickupTime) + delayBadge(L.pickupDelayDays, L.delayNote)]);
  else if (L.pickupDelayDays != null || L.delayNote) rows.push(["Pickup", delayBadge(L.pickupDelayDays, L.delayNote)]);
  rows.push(["Refusals to come down", `${c.refusals || 0}/2`]);
  rows.push(["Offers recorded", String((c.offers || []).length)]);

  return `
    <div class="carrier ${status}">
      <div class="carrier-head">
        <span class="carrier-name">${name}</span>
        <span class="badge ${status}">${statusLabel}</span>
      </div>
      <div class="price">${fmtMxn(L.priceMxn)}<span class="cur">MXN</span>${capVs(L.priceMxn)}</div>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
      ${conds ? `<div class="conds">${conds}</div>` : ""}
      ${
        (c.offers || []).length
          ? `<details><summary>History (${c.offers.length})</summary><pre>${escapeHtml(
              JSON.stringify(c.offers, null, 2)
            )}</pre></details>`
          : ""
      }
    </div>`;
}

function renderCarriers() {
  const list = [...negs.values()].sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""));
  if (!list.length) {
    carriersEl.className = "hint";
    carriersEl.textContent = "No carrier call yet.";
    return;
  }
  carriersEl.className = "";
  carriersEl.innerHTML = list.map(carrierCard).join("");
}

// When a round has closed, its result takes over the "Final decision" panel.
let roundResult = null;

function renderRoundBanner(d) {
  const rows = (d.ranking || [])
    .map((r, i) => {
      const mark = r.callId === d.winnerCallId ? "🏆 " : r.eligible ? "• " : "✗ ";
      const price = r.priceMxn != null ? "$" + Number(r.priceMxn).toLocaleString("en-US") : "—";
      const why = r.disqualifiers && r.disqualifiers.length
        ? ` <span class="anon">(${escapeHtml(r.disqualifiers.join("; "))})</span>`
        : "";
      const delay = r.pickupDelayDays > 0 ? ` +${r.pickupDelayDays}d` : "";
      return `<li>${mark}<strong>${escapeHtml(r.carrierName)}</strong> — ${price}${escapeHtml(delay)}${why}</li>`;
    })
    .join("");
  const review = (d.needsHumanReview || [])
    .map((x) => `<li>${escapeHtml(x.carrierName)} — ${escapeHtml(x.why)}</li>`)
    .join("");
  decisionEl.className = "decision " + (d.outcome === "deal" ? "deal" : "no_deal");
  decisionEl.innerHTML = `
    <div class="outcome">${d.outcome === "deal" ? "✓ ROUND WON" : "✗ ROUND — NO CLEAN WINNER"}</div>
    <div class="summary">${escapeHtml(d.reason || "")}</div>
    <ol class="kv" style="list-style:none;padding:0">${rows}</ol>
    ${review ? `<div class="relay"><div class="relay-title">Needs human review</div><ul>${review}</ul></div>` : ""}`;
}

export function renderRoundResult(decision) {
  roundResult = decision || null;
  renderDecision();
}

function renderDecision() {
  if (roundResult) return renderRoundBanner(roundResult);
  const done = [...negs.values()].filter((c) => c.final);
  if (!done.length) {
    decisionEl.className = "hint";
    decisionEl.textContent = "No negotiation has closed yet.";
    return;
  }
  // Prefer showing the closed deal; if there is none, the latest close.
  const c =
    done.find((x) => x.final.outcome === "deal") ||
    done.sort((a, b) => (a.final.decidedAt || "").localeCompare(b.final.decidedAt || "")).slice(-1)[0];
  const f = c.final;
  const name = c.carrierName || "the carrier";
  const head =
    f.outcome === "deal"
      ? `✓ DEAL CLOSED with ${escapeHtml(name)}`
      : `✗ NO DEAL with ${escapeHtml(name)}`;
  const relay = [];
  if (f.pickupDelayDays > 0 || f.delayNote) {
    const d = f.pickupDelayDays > 0 ? `Pickup ${f.pickupDelayDays} day${f.pickupDelayDays === 1 ? "" : "s"} late` : "Pickup date deviation";
    relay.push(d + (f.delayNote ? ` — ${f.delayNote}` : ""));
  }
  for (const cond of f.conditionsToRelay || []) relay.push(cond);

  const priceLine =
    f.priceMxn != null
      ? `<div class="price">${fmtMxn(f.priceMxn)}<span class="cur">MXN</span>${
          f.priceWithinCap === false
            ? `<span class="vs over">OVER cap (${fmtMxn(mandateCap)})</span>`
            : f.priceWithinCap === true
            ? `<span class="vs under">within cap (${fmtMxn(mandateCap)})</span>`
            : ""
        }</div>`
      : "";
  const rows = [];
  if (f.pickupTime) rows.push(["Pickup", escapeHtml(f.pickupTime) + delayBadge(f.pickupDelayDays, null)]);

  decisionEl.className = "decision " + f.outcome;
  decisionEl.innerHTML = `
    <div class="outcome">${head}</div>
    ${priceLine}
    ${rows.length ? `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>` : ""}
    <div class="relay">
      <div class="relay-title">To relay to the client</div>
      ${
        relay.length
          ? `<ul>${relay.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>`
          : `<span class="empty">No deviations or conditions to report.</span>`
      }
    </div>
    ${f.summary ? `<div class="summary">${escapeHtml(f.summary)}</div>` : ""}`;
}

// An event brought news about a negotiation.
export function upsertNeg(rec) {
  if (!rec || !rec.callId) return;
  const prev = negs.get(rec.callId);
  // If the event carries the full record we use it; otherwise keep the previous.
  negs.set(rec.callId, rec.offers ? rec : prev || rec);
  renderCarriers();
  renderDecision();
}

// Re-read the backend state (source of truth) and repaint.
export function refreshNegotiations() {
  return fetch("/negotiations")
    .then((r) => r.json())
    .then((list) => {
      if (!Array.isArray(list)) return;
      negs.clear();
      for (const c of list) negs.set(c.callId, c);
      renderCarriers();
      renderDecision();
    })
    .catch(() => {});
}

export function clearNegotiations() {
  negs.clear();
  roundResult = null;
  renderCarriers();
  renderDecision();
}

// --- simulated inbound call (browser mode only) ------------------------------
export function showIncomingCall() {
  setPhase("ringing");
  phaseChip.hidden = true;
  incoming.hidden = false;
}

export function hideIncomingCall() {
  incoming.hidden = true;
}

// On load: previous mandate (sets the cap), then previous negotiations.
export function loadInitialState() {
  return fetch("/mandate")
    .then((r) => r.json())
    .then((m) => m && renderMandate(m))
    .catch(() => {})
    .finally(refreshNegotiations);
}
