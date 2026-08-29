// ============================================================================
// render.js — TODO lo que dibuja en pantalla.
// Dueño: diseño.
//
// Este archivo es el único que toca el DOM. No sabe nada de WebSockets, de
// Twilio ni de audio: recibe datos ya masticados y los pinta. Si querés cambiar
// cómo se ve una tarjeta, un badge o un panel, es todo acá (y en styles.css).
//
// El contrato con client.js son las funciones exportadas de abajo. Mientras
// sigan existiendo con el mismo nombre, podés reescribir el interior entero sin
// romperle nada a nadie.
// ============================================================================

// Los elementos de la página. client.js los usa para escuchar clicks y leer
// los inputs; el resto del dibujo pasa por las funciones de este archivo.
export const ui = {
  dot: document.getElementById("dot"),
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

let mandateCap = null; // tope de precio del cliente, para comparar contra ofertas

export function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// --- estado general de la pantalla ------------------------------------------

// Puntito verde: hay conexión con el backend.
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
    phaseChip.textContent = "intake · cliente";
    hintEl.textContent = "Volta está tomando el encargo y el precio máximo.";
  } else if (p === "negotiate") {
    phaseChip.hidden = false;
    phaseChip.className = "chip negotiate";
    phaseChip.textContent = "negociación · carrier";
    hintEl.textContent = "Volta busca el precio más bajo; se niega 2 veces y corta.";
  } else {
    phaseChip.hidden = true;
  }
}

// Contador de negativas en el chip de fase.
export function setRefusals(n) {
  if (n) phaseChip.textContent = `negociación · negativas ${n}/2`;
}

// --- barra del teléfono ------------------------------------------------------
export function setPhoneNumber(text) {
  phoneNum.textContent = text;
}

// kind: "" (neutro) | "live" (verde) | "err" (rojo)
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

// --- conversación y actividad del backend ------------------------------------
export function addMessage(who, text) {
  const d = document.createElement("div");
  d.className = "msg " + (who === "user" ? "user" : "agent");
  d.innerHTML = `<div class="who">${who === "user" ? "Interlocutor" : "Volta"}</div>${escapeHtml(text)}`;
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
    d.innerHTML = `<span class="name">⚡ barge-in</span> (interrumpieron al agente)`;
  } else if (kind === "error") {
    d.innerHTML = `<span class="name" style="color:#ff8f9c">error</span><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
  }
  toolsEl.appendChild(d);
  toolsEl.scrollTop = toolsEl.scrollHeight;
}

// --- panel del mandato capturado ---------------------------------------------
export function renderMandate(m, opts = {}) {
  if (!m) return;
  mandateCard.classList.remove("empty");
  if (opts.justCaptured) mandateCard.classList.add("captured");
  mPrice.textContent =
    m.maxPriceMxn != null ? Number(m.maxPriceMxn).toLocaleString("es-MX") : "—";
  const rows = [
    ["Origen", m.origin],
    ["Destino", m.destination],
    ["Contenedor", m.containerNumber],
    ["Pickup desde", m.pickupWindowStart],
    ["Pickup hasta", m.pickupWindowEnd],
    ["Condiciones vetadas", (m.forbiddenConditions || []).join(", ")],
    ["Notas", m.notes],
  ].filter(([, v]) => v);
  mFields.innerHTML = rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join("");
  const when = m.capturedAt ? new Date(m.capturedAt).toLocaleTimeString() : "";
  mStatus.textContent = "Mandato guardado" + (when ? " · " + when : "");
  mandateCap = m.maxPriceMxn != null ? Number(m.maxPriceMxn) : mandateCap;
}

export function setMandateDone(text) {
  mStatus.textContent = text;
  mStatus.classList.add("done");
}

// --- panel de negociación con carriers ---------------------------------------
const negs = new Map(); // callId -> registro de negociación

function fmtMxn(n) {
  return n != null ? "$" + Number(n).toLocaleString("es-MX") : "—";
}

function delayBadge(days, note) {
  if (days == null && !note) return "";
  if (days === 0 && !note) return `<span class="delay none">en ventana</span>`;
  const label = days > 0 ? `+${days} día${days === 1 ? "" : "s"}` : (note ? "demora" : "");
  return `<span class="delay">⏱ ${escapeHtml(label)}${note ? " · " + escapeHtml(note) : ""}</span>`;
}

function capVs(price) {
  if (price == null || mandateCap == null) return "";
  const cls = price <= mandateCap ? "under" : "over";
  const rel = price <= mandateCap ? "dentro del tope" : "SOBRE el tope";
  return `<span class="vs ${cls}">${rel} (${fmtMxn(mandateCap)})</span>`;
}

function carrierCard(c) {
  const L = c.latest || { conditions: [] };
  const name = c.carrierName
    ? escapeHtml(c.carrierName)
    : `<span class="anon">Carrier (sin nombre)</span>`;
  const status = c.status || "in_progress";
  const statusLabel = { in_progress: "en curso", deal: "trato", no_deal: "sin trato" }[status];
  const conds = (L.conditions || [])
    .map((x) => `<span class="cond-chip">${escapeHtml(x)}</span>`)
    .join("");
  const rows = [];
  if (L.pickupTime) rows.push(["Pickup", escapeHtml(L.pickupTime) + delayBadge(L.pickupDelayDays, L.delayNote)]);
  else if (L.pickupDelayDays != null || L.delayNote) rows.push(["Pickup", delayBadge(L.pickupDelayDays, L.delayNote)]);
  rows.push(["Negativas a bajar", `${c.refusals || 0}/2`]);
  rows.push(["Ofertas registradas", String((c.offers || []).length)]);

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
          ? `<details><summary>Historial (${c.offers.length})</summary><pre>${escapeHtml(
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
    carriersEl.textContent = "Ninguna llamada a carrier todavía.";
    return;
  }
  carriersEl.className = "";
  carriersEl.innerHTML = list.map(carrierCard).join("");
}

function renderDecision() {
  const done = [...negs.values()].filter((c) => c.final);
  if (!done.length) {
    decisionEl.className = "hint";
    decisionEl.textContent = "Todavía no cerró ninguna negociación.";
    return;
  }
  // Preferimos mostrar el trato cerrado; si no hay, el último cierre.
  const c =
    done.find((x) => x.final.outcome === "deal") ||
    done.sort((a, b) => (a.final.decidedAt || "").localeCompare(b.final.decidedAt || "")).slice(-1)[0];
  const f = c.final;
  const name = c.carrierName || "el carrier";
  const head =
    f.outcome === "deal"
      ? `✓ TRATO CERRADO con ${escapeHtml(name)}`
      : `✗ SIN TRATO con ${escapeHtml(name)}`;
  const relay = [];
  if (f.pickupDelayDays > 0 || f.delayNote) {
    const d = f.pickupDelayDays > 0 ? `Pickup con ${f.pickupDelayDays} día${f.pickupDelayDays === 1 ? "" : "s"} de demora` : "Desvío de fecha de pickup";
    relay.push(d + (f.delayNote ? ` — ${f.delayNote}` : ""));
  }
  for (const cond of f.conditionsToRelay || []) relay.push(cond);

  const priceLine =
    f.priceMxn != null
      ? `<div class="price">${fmtMxn(f.priceMxn)}<span class="cur">MXN</span>${
          f.priceWithinCap === false
            ? `<span class="vs over">SOBRE el tope (${fmtMxn(mandateCap)})</span>`
            : f.priceWithinCap === true
            ? `<span class="vs under">dentro del tope (${fmtMxn(mandateCap)})</span>`
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
      <div class="relay-title">A comunicar al cliente</div>
      ${
        relay.length
          ? `<ul>${relay.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>`
          : `<span class="empty">Sin desvíos ni condiciones para reportar.</span>`
      }
    </div>
    ${f.summary ? `<div class="summary">${escapeHtml(f.summary)}</div>` : ""}`;
}

// Un evento trajo novedades de una negociación.
export function upsertNeg(rec) {
  if (!rec || !rec.callId) return;
  const prev = negs.get(rec.callId);
  // Si el evento trae el registro completo, lo usamos; si no, conservamos el previo.
  negs.set(rec.callId, rec.offers ? rec : prev || rec);
  renderCarriers();
  renderDecision();
}

// Relee el estado del backend (fuente de verdad) y repinta.
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
  renderCarriers();
  renderDecision();
}

// --- llamada entrante simulada (solo modo navegador) -------------------------
export function showIncomingCall() {
  setPhase("ringing");
  phaseChip.hidden = true;
  incoming.hidden = false;
}

export function hideIncomingCall() {
  incoming.hidden = true;
}

// Al cargar: mandato previo (fija el tope) y después las negociaciones previas.
export function loadInitialState() {
  return fetch("/mandate")
    .then((r) => r.json())
    .then((m) => m && renderMandate(m))
    .catch(() => {})
    .finally(refreshNegotiations);
}
