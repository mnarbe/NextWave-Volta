// Volta's DOM contract. client.js owns transport and events; this module owns presentation.
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
const routeOrigin = document.getElementById("routeOrigin");
const routeDestination = document.getElementById("routeDestination");
const mandateTerms = document.getElementById("mandateTerms");
const carriersEl = document.getElementById("carriers");
const decisionEl = document.getElementById("decision");
const phoneNum = document.getElementById("phoneNum");
const phoneState = document.getElementById("phoneState");

const drawer = document.getElementById("conversationDrawer");
const drawerScrim = document.getElementById("drawerScrim");
const drawerClose = document.getElementById("drawerClose");
const drawerTitle = document.getElementById("drawerTitle");
const drawerStatus = document.getElementById("drawerStatus");
const drawerPrice = document.getElementById("drawerPrice");
const drawerEvidenceBody = document.getElementById("drawerEvidenceBody");
const drawerHistory = document.getElementById("drawerHistory");

let mandateCap = null;
let mandateRecord = null;
let roundResult = null;
let selectedCallId = null;
let lastUpdatedCallId = null;
let activePhase = "idle";
const negs = new Map();
const transcripts = new Map();
const generalTranscript = [];

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function fmtMxn(value, withSymbol = true) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const amount = Number(value).toLocaleString("es-AR", { maximumFractionDigits: 0 });
  return `${withSymbol ? "$" : ""}${amount}`;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fmtDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value || "—";
  const months = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
  return `${match[3]} ${months[Number(match[2]) - 1]} ${match[1]}`;
}

function fmtTime(value) {
  const match = String(value || "").match(/T(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : "—";
}

function statusLabel(status) {
  return ({ in_progress: "Negociando", deal: "Cerrada", no_deal: "Sin acuerdo" })[status] || "Abierta";
}

function transcriptKey(name) {
  return String(name || "").trim().toLowerCase();
}

function activeHumanNegotiation() {
  return [...negs.values()].find((record) => record.kind === "human" && record.status === "in_progress");
}

function localizeStatus(value) {
  const text = String(value || "");
  if (/^No phone: use browser mode\.?$/i.test(text)) return "Teléfono no configurado · usá modo navegador.";
  if (/^missing in \.env:/i.test(text)) return "Configuración telefónica incompleta.";
  if (/^could not reach \/twilio\/health/i.test(text)) return "No se pudo consultar el estado telefónico.";
  if (/^no call$/i.test(text)) return "Sin llamada";
  if (/^dialling/i.test(text)) return "Marcando…";
  if (/^on a call with the carrier$/i.test(text)) return "Llamada activa con carrier";
  if (/^on a call with the client$/i.test(text)) return "Llamada activa con cliente";
  if (/^change needs the client's decision$/i.test(text)) return "El cambio necesita decisión del cliente";
  if (/^Call .+ and hand Volta the job\.?$/i.test(text)) return "Llamá a Volta para entregar el mandato.";
  if (/^No phone:/i.test(text)) return "Teléfono no disponible · usá modo navegador.";
  if (/^Round running/i.test(text)) return "Ronda en curso · las negociaciones avanzan en paralelo.";
  if (/^Round complete/i.test(text)) return "Ronda completa.";
  if (/^Intake done/i.test(text)) return "Mandato completo · comienza la negociación.";
  return text;
}

export function setConnected(on) {
  const connected = Boolean(on);
  ui.dot.classList.toggle("on", connected);
  document.body.classList.toggle("is-offline", !connected);
}

export function setHint(text) {
  hintEl.textContent = localizeStatus(text);
}

export function setPhase(phase) {
  activePhase = phase || "idle";
  if (phase === "intake") {
    phaseChip.hidden = false;
    phaseChip.textContent = "Mandato · cliente";
    hintEl.textContent = "Volta está capturando el mandato.";
  } else if (phase === "negotiate") {
    phaseChip.hidden = false;
    phaseChip.textContent = "Negociación · carrier";
    hintEl.textContent = "Volta está negociando precio y condiciones.";
  } else {
    phaseChip.hidden = true;
    hintEl.textContent = roundResult ? roundResult.reason : "Esperando actividad.";
  }
}

export function setRefusals(count) {
  if (count) phaseChip.textContent = `Negociación · ${count}/2 negativas`;
}

export function setPhoneNumber(text) {
  phoneNum.textContent = String(text || "").replace(/^phone:/i, "Teléfono:");
}

export function setPhoneState(text, kind) {
  phoneState.textContent = localizeStatus(text);
  phoneState.className = `phone-state${kind ? ` ${kind}` : ""}`;
}

export function setCallButtonEnabled(on) {
  ui.callBtn.disabled = !on;
}

export function setHangupVisible(on) {
  ui.hangBtn.hidden = !on;
}

function pushTranscript(name, item) {
  const key = transcriptKey(name);
  if (!key) return;
  const list = transcripts.get(key) || [];
  list.push(item);
  transcripts.set(key, list.slice(-80));
}

export function addMessage(who, text) {
  const raw = String(text || "");
  const match = raw.match(/^\[([^\]]+)\]\s*(.*)$/s);
  const currentHuman = activeHumanNegotiation();
  const carrierName = match?.[1] || currentHuman?.carrierName || null;
  const body = match?.[2] || raw;
  const item = {
    who: who === "user" ? "user" : "agent",
    text: body,
    ts: new Date().toISOString(),
  };

  generalTranscript.push({ ...item, carrierName });
  if (carrierName) pushTranscript(carrierName, item);
  if (selectedCallId) renderDrawer();
}

export function addTool(kind, data) {
  const item = document.createElement("div");
  item.className = "tool";
  const name = data?.name || kind || "evento";
  const payload = kind === "tool_call" ? data?.args : data?.result ?? data;
  item.innerHTML = `<span class="name">${escapeHtml(name)}</span><pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
  toolsEl.appendChild(item);
}

export function renderMandate(mandate, options = {}) {
  if (!mandate) return;
  mandateRecord = mandate;
  mandateCap = mandate.maxPriceMxn != null ? Number(mandate.maxPriceMxn) : mandateCap;
  mandateCard.classList.remove("empty");
  mandateCard.classList.toggle("captured", Boolean(options.justCaptured));
  routeOrigin.textContent = mandate.origin || "Origen pendiente";
  routeDestination.textContent = mandate.destination || "Destino pendiente";
  const pickupDate = fmtDate(mandate.pickupWindowStart);
  const pickupStart = fmtTime(mandate.pickupWindowStart);
  const pickupEnd = fmtTime(mandate.pickupWindowEnd);
  mFields.innerHTML = `
    <div><small>Contenedor</small><b>${escapeHtml(mandate.containerNumber || "—")}</b></div>
    <div><small>Retiro requerido</small><b>${escapeHtml(pickupDate)}</b><span>${escapeHtml(`${pickupStart}–${pickupEnd}`)}</span></div>
    <div class="max-fact"><small>Precio máximo</small><strong id="mPrice">${escapeHtml(fmtMxn(mandate.maxPriceMxn))}</strong><span>MXN</span></div>`;

  const terms = [];
  const forbidden = mandate.forbiddenConditions || [];
  if (forbidden.some((term) => /prepayment|prepago/i.test(term))) terms.push("Sin prepago");
  if (forbidden.some((term) => /no insurance|seguro/i.test(term))) terms.push("Seguro obligatorio");
  for (const term of forbidden) {
    if (!/prepayment|prepago|no insurance|seguro/i.test(term)) terms.push(term);
  }
  mandateTerms.innerHTML = (terms.length ? terms : ["Sin condiciones adicionales"])
    .map((term) => `<span>${escapeHtml(term)}</span>`)
    .join("");

  const when = mandate.capturedAt ? new Date(mandate.capturedAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
  mStatus.textContent = `Mandato guardado${when ? ` · ${when}` : ""}`;
  mandateCard.querySelector(".mandate-stamp").innerHTML = "Mandato<br>activo";
  renderCarriers();
  renderDecision();
}

export function setMandateDone(text) {
  mStatus.textContent = /^Intake complete/i.test(String(text || ""))
    ? "Mandato completo · Volta terminó la llamada con el cliente."
    : localizeStatus(text);
  mStatus.classList.add("done");
}

function comparisonFor(callId) {
  return roundResult?.ranking?.find((record) => record.callId === callId) || null;
}

function carrierPresentation(record) {
  const latest = record.latest || { conditions: [] };
  const final = record.final;
  const comparison = comparisonFor(record.callId);
  const delay = final?.pickupDelayDays ?? latest.pickupDelayDays ?? 0;
  const price = final?.priceMxn ?? latest.priceMxn;
  const overCap = price != null && mandateCap != null && Number(price) > Number(mandateCap);
  const late = delay > 0;
  const winner = roundResult?.winnerCallId === record.callId;
  const disqualifiers = comparison?.disqualifiers || [];
  const invalid = comparison ? !comparison.eligible : Boolean(final && (overCap || late));
  let stamp = statusLabel(record.status);
  let note = record.status === "in_progress" ? "Volta sigue negociando" : "Conversación cerrada";

  if (winner) {
    stamp = "Válido · a tiempo";
    note = "Menor oferta elegible";
  } else if (late) {
    stamp = "Inválido · tarde";
    note = "Más barato, pero llega tarde";
  } else if (overCap) {
    stamp = "Sobre máximo";
    note = record.status === "in_progress" ? "Volta prepara contrapropuesta" : "Excede el mandato";
  } else if (comparison?.eligible) {
    stamp = "Oferta válida";
    note = "Cumple el mandato";
  } else if (record.status === "no_deal") {
    stamp = "Sin acuerdo";
    note = "No cerró una oferta";
  }

  return { latest, final, comparison, delay, price, overCap, late, winner, invalid, disqualifiers, stamp, note };
}

function carrierTicket(record) {
  const view = carrierPresentation(record);
  const classes = [
    "ticket",
    view.winner ? "winner" : "",
    view.late ? "late" : "",
    view.overCap ? "over" : "",
    view.invalid ? "invalid" : "",
    record.status === "in_progress" ? "negotiating" : "",
    lastUpdatedCallId === record.callId ? "updated" : "",
  ].filter(Boolean).join(" ");
  const kind = record.kind === "human" ? "Humano" : record.kind === "sim" ? "Sim" : "Carrier";
  const buttonLabel = `Abrir conversación con ${record.carrierName || "carrier"}`;
  return `
    <article class="${classes}">
      <button class="ticket-main" data-call-id="${escapeHtml(record.callId)}" aria-label="${escapeHtml(buttonLabel)}" aria-expanded="${selectedCallId === record.callId}">
        <span class="ticket-identity"><small>${escapeHtml(kind)} · ${escapeHtml(statusLabel(record.status))}</small><b>${escapeHtml(record.carrierName || "Carrier sin nombre")}</b></span>
        <span class="stamp">${escapeHtml(view.stamp)}</span>
        <span class="ticket-offer"><small>${record.status === "in_progress" ? "Última oferta" : "Oferta actual"}</small><strong>${escapeHtml(fmtMxn(view.price))}</strong> <i>MXN</i></span>
        <span class="ticket-note">${escapeHtml(view.note)}</span>
      </button>
    </article>`;
}

function renderCarriers() {
  const list = [...negs.values()].sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || ""));
  if (!list.length) {
    carriersEl.className = "carriers-empty";
    carriersEl.innerHTML = "<p>Todavía no hay conversaciones con carriers.</p>";
    return;
  }
  carriersEl.className = "";
  carriersEl.innerHTML = list.map(carrierTicket).join("");
}

function renderRoundDecision(decision) {
  const winner = decision.ranking?.find((record) => record.callId === decision.winnerCallId);
  if (winner) {
    decisionEl.className = "decision-slip deal";
    decisionEl.innerHTML = `
      <p class="eyebrow">Decisión determinística</p>
      <span class="stamp">Seleccionado</span>
      <h3>${escapeHtml(winner.carrierName)}</h3>
      <span class="decision-price">${escapeHtml(fmtMxn(winner.priceMxn))} <small>MXN</small></span>
      <p>Menor oferta válida, dentro del máximo y a tiempo.</p>`;
    return;
  }

  const review = decision.needsHumanReview || [];
  decisionEl.className = "decision-slip no-deal";
  decisionEl.innerHTML = `
    <p class="eyebrow">Decisión determinística</p>
    <span class="stamp">Intervención</span>
    <h3>Sin ganador limpio</h3>
    <p>${escapeHtml(decision.reason || "Ninguna oferta cumple todo el mandato.")}</p>
    ${review.length ? `<div class="review-list">${review.map((item) => `<span>${escapeHtml(item.carrierName)} · ${escapeHtml(item.why)}</span>`).join("")}</div>` : ""}`;
}

function renderDecision() {
  if (roundResult) return renderRoundDecision(roundResult);
  const finished = [...negs.values()].filter((record) => record.final);
  if (!finished.length) {
    decisionEl.className = "decision-slip empty";
    decisionEl.innerHTML = `
      <p class="eyebrow">Decisión determinística</p>
      <h3>La ronda todavía no cerró</h3>
      <p>Cuando haya ofertas, Volta elegirá la menor que cumpla precio, horario y condiciones.</p>`;
    return;
  }
  const deal = finished.find((record) => record.final?.outcome === "deal");
  if (!deal) {
    decisionEl.className = "decision-slip no-deal";
    decisionEl.innerHTML = `<p class="eyebrow">Decisión pendiente</p><span class="stamp">En espera</span><h3>Sin acuerdo limpio</h3><p>La ronda necesita más ofertas o intervención humana.</p>`;
    return;
  }
  const price = deal.final.priceMxn ?? deal.latest?.priceMxn;
  decisionEl.className = "decision-slip deal";
  decisionEl.innerHTML = `<p class="eyebrow">Mejor cierre disponible</p><span class="stamp">Oferta cerrada</span><h3>${escapeHtml(deal.carrierName || "Carrier")}</h3><span class="decision-price">${escapeHtml(fmtMxn(price))} <small>MXN</small></span><p>Esperando que termine la ronda para adjudicar.</p>`;
}

export function renderRoundResult(decision) {
  roundResult = decision || null;
  renderCarriers();
  renderDecision();
  if (selectedCallId) renderDrawer();
}

export function upsertNeg(record) {
  if (!record?.callId) return;
  const previous = negs.get(record.callId);
  negs.set(record.callId, record.offers ? record : previous || record);
  lastUpdatedCallId = record.callId;
  renderCarriers();
  renderDecision();
  if (selectedCallId === record.callId) renderDrawer();
  window.setTimeout(() => {
    if (lastUpdatedCallId === record.callId) {
      lastUpdatedCallId = null;
      renderCarriers();
    }
  }, 850);
}

export function refreshNegotiations() {
  return fetch("/negotiations")
    .then((response) => response.json())
    .then((list) => {
      if (!Array.isArray(list)) return;
      negs.clear();
      for (const record of list) negs.set(record.callId, record);
      renderCarriers();
      renderDecision();
      if (selectedCallId) renderDrawer();
    })
    .catch(() => {});
}

function refreshRound() {
  return fetch("/round")
    .then((response) => response.json())
    .then((state) => {
      if (state?.decision) renderRoundResult(state.decision);
      if (state?.waitingForHuman) setHint(`Esperando a ${state.waitingForHuman}.`);
    })
    .catch(() => {});
}

export function clearNegotiations() {
  negs.clear();
  transcripts.clear();
  roundResult = null;
  selectedCallId = null;
  closeConversation();
  renderCarriers();
  renderDecision();
}

function transcriptFor(record) {
  const exact = transcripts.get(transcriptKey(record.carrierName));
  if (exact?.length) return exact;
  return generalTranscript.filter((item) => transcriptKey(item.carrierName) === transcriptKey(record.carrierName));
}

function renderConversation(record) {
  const list = transcriptFor(record);
  if (!list.length) {
    convo.innerHTML = `<p class="drawer-empty">La conversación aparecerá acá en cuanto llegue la primera transcripción.</p>`;
    return;
  }
  convo.innerHTML = list.map((item) => {
    const time = new Date(item.ts).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `<article class="message ${item.who}"><div class="message-head"><b>${item.who === "agent" ? "Volta" : "Carrier"}</b><time>${escapeHtml(time)}</time></div><p>${escapeHtml(item.text)}</p></article>`;
  }).join("");
}

function renderEvidence(record, view) {
  const latest = view.latest || {};
  const pickup = view.final?.pickupTime || latest.pickupTime;
  const conditions = view.final?.conditionsToRelay || latest.conditions || [];
  const disqualifiers = view.disqualifiers.length
    ? view.disqualifiers
    : [view.overCap ? "Precio sobre el máximo" : "", view.late ? "Retiro fuera de ventana" : ""].filter(Boolean);
  drawerEvidenceBody.innerHTML = `
    <div class="evidence-row"><span>Retiro propuesto</span><b>${escapeHtml(pickup ? `${fmtDate(pickup)} · ${fmtTime(pickup)}` : "Sin horario confirmado")}</b></div>
    <div class="evidence-row ${view.late ? "bad" : ""}"><span>Ventana</span><b>${view.late ? `+${view.delay} día${view.delay === 1 ? "" : "s"}` : "Dentro del mandato"}</b></div>
    <div class="evidence-row ${view.overCap ? "bad" : ""}"><span>Precio</span><b>${view.overCap ? "Sobre el máximo" : "Dentro del máximo"}</b></div>
    <div class="evidence-row"><span>Condiciones</span><b>${escapeHtml(conditions.length ? conditions.join(" · ") : "Sin condiciones")}</b></div>
    ${disqualifiers.length ? `<div class="evidence-row bad"><span>Causa</span><b>${escapeHtml(disqualifiers.join(" · "))}</b></div>` : ""}`;

  const offers = record.offers || [];
  drawerHistory.innerHTML = offers.length
    ? offers.slice().reverse().map((offer) => `<div class="history-entry">${escapeHtml(fmtMxn(offer.priceMxn))} · ${escapeHtml(offer.pickupTime ? `${fmtDate(offer.pickupTime)} ${fmtTime(offer.pickupTime)}` : "sin horario")} ${offer.note ? `· ${escapeHtml(offer.note)}` : ""}</div>`).join("")
    : `<p class="drawer-empty">No hay ofertas registradas.</p>`;
}

function renderDrawer() {
  const record = negs.get(selectedCallId);
  if (!record) return;
  const view = carrierPresentation(record);
  drawerTitle.textContent = record.carrierName || "Carrier";
  drawerStatus.textContent = `${statusLabel(record.status)}${activePhase === "negotiate" && record.status === "in_progress" ? " · llamada activa" : ""}`;
  drawerPrice.textContent = fmtMxn(view.price);
  renderConversation(record);
  renderEvidence(record, view);
}

function openConversation(callId) {
  if (!negs.has(callId)) return;
  selectedCallId = callId;
  renderDrawer();
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  drawerScrim.hidden = false;
  document.body.classList.add("drawer-open");
  renderCarriers();
  drawerClose.focus();
}

function closeConversation() {
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  drawerScrim.hidden = true;
  document.body.classList.remove("drawer-open");
  selectedCallId = null;
  renderCarriers();
}

carriersEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-call-id]");
  if (button) openConversation(button.dataset.callId);
});
drawerClose.addEventListener("click", closeConversation);
drawerScrim.addEventListener("click", closeConversation);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && drawer.classList.contains("open")) closeConversation();
});

document.querySelectorAll("[data-drawer-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = button.dataset.drawerTab;
    document.querySelectorAll("[data-drawer-tab]").forEach((tab) => {
      const active = tab === button;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-pressed", String(active));
    });
    document.querySelectorAll(".drawer-panel").forEach((panel) => panel.classList.remove("active"));
    document.getElementById(target === "conversation" ? "drawerConversation" : "drawerEvidence").classList.add("active");
  });
});

export function showIncomingCall() {
  setPhase("ringing");
  phaseChip.hidden = true;
  incoming.hidden = false;
}

export function hideIncomingCall() {
  incoming.hidden = true;
}

export function loadInitialState() {
  return fetch("/mandate")
    .then((response) => response.json())
    .then((mandate) => mandate && renderMandate(mandate))
    .catch(() => {})
    .finally(() => Promise.all([refreshNegotiations(), refreshRound()]));
}
