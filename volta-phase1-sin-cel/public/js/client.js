// ============================================================================
// client.js — el cableado del dashboard.
// Dueño: llamada.
//
// Abre el WebSocket con el backend, traduce cada evento a una llamada a
// render.js, y maneja los botones del teléfono (marcar / colgar) y el modo
// micrófono. No dibuja nada por su cuenta: todo lo visual pasa por render.js.
// ============================================================================
import * as view from "./render.js";
import { startCapture, stopCapture, playAudio, clearAudio } from "./audio.js";

const el = view.ui; // los elementos de la página

let ws = null;
let micMode = false;      // ¿esta pestaña está haciendo de línea con el micrófono?
let activeCallSid = null; // llamada telefónica en curso (para el botón Colgar)

// --- conexión ---------------------------------------------------------------
// Se conecta al cargar la página, SIN micrófono: escucha los eventos de las
// llamadas (telefónicas o del navegador) y pinta la pantalla.
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => view.setConnected(true);
  ws.onmessage = onServerMessage;
  ws.onclose = () => {
    view.setConnected(false);
    ws = null;
    if (micMode) stopMic();
    setTimeout(connect, 1500); // el dashboard se reconecta solo
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// --- eventos del backend ------------------------------------------------------
function onServerMessage(ev) {
  const msg = JSON.parse(ev.data);

  // Audio: solo llega en modo navegador (por teléfono lo reproduce Twilio).
  if (msg.type === "audio") return playAudio(msg.audio);
  if (msg.type === "clear") return clearAudio();
  if (msg.type === "started") {
    if (msg.mode === "negotiate") {
      view.addTool("tool_result", { name: "mandate loaded", result: msg.mandate });
    }
    return;
  }
  if (msg.type !== "event") return;

  const phone = msg.transport === "phone";

  switch (msg.kind) {
    case "user_transcript": view.addMessage("user", msg.data); break;
    case "agent_transcript": view.addMessage("agent", msg.data); break;

    // --- llamadas telefónicas -------------------------------------------------
    case "phone_call_started": {
      const mode = (msg.data && msg.data.mode) || "intake";
      view.setPhoneState(
        mode === "negotiate" ? "en llamada con el carrier" : "en llamada con el cliente",
        "live"
      );
      activeCallSid = (msg.data && msg.data.callSid) || null;
      view.setHangupVisible(Boolean(activeCallSid));
      view.setPhase(mode === "negotiate" ? "negotiate" : "intake");
      break;
    }

    case "phone_call_ended":
      view.setPhoneState("sin llamada");
      activeCallSid = null;
      view.setHangupVisible(false);
      view.setPhase("idle");
      break;

    case "call_started":
      if (phone) view.addTool("tool_result", { name: "call started", result: msg.data });
      break;

    // --- negocio ---------------------------------------------------------------
    case "mandate_captured":
      view.renderMandate(msg.data, { justCaptured: true });
      view.addTool("tool_result", { name: "mandate_captured", result: msg.data });
      view.clearNegotiations(); // trabajo nuevo: limpiamos el panel de carriers
      if (!phone) el.forceCutBtn.hidden = false; // red de seguridad del modo navegador
      break;

    case "carrier_offer":
      if (msg.data && msg.data.offers) view.upsertNeg(msg.data);
      else view.refreshNegotiations();
      view.addTool("tool_result", { name: "log_carrier_offer", result: msg.data });
      break;

    case "intake_done":
      el.forceCutBtn.hidden = true;
      view.setMandateDone("Intake completo — Volta cortó con el cliente.");
      view.addMessage("agent", "— fin del intake —");
      // Por teléfono el siguiente paso es marcarle al carrier; en modo
      // navegador simulamos la llamada entrante como antes.
      if (phone) {
        view.setHint("Ahora llamá al carrier desde la barra de arriba.");
        el.carrierNum.focus();
      } else {
        view.showIncomingCall();
      }
      break;

    case "carrier_refusal":
      view.setRefusals(msg.data && msg.data.refusals);
      view.refreshNegotiations();
      view.addTool("tool_result", { name: "note_carrier_refusal", result: msg.data });
      break;

    case "negotiation_done": {
      const outcome = (msg.data && msg.data.outcome) || "no_deal";
      if (msg.data && msg.data.carrier) view.upsertNeg(msg.data.carrier);
      else view.refreshNegotiations();
      view.addMessage(
        "agent",
        `— fin de la negociación · ${outcome === "deal" ? "trato cerrado" : "sin trato"} —`
      );
      if (!phone) setTimeout(stopMic, 900);
      break;
    }

    default:
      view.addTool(msg.kind, msg.data);
  }
}

// --- teléfono ----------------------------------------------------------------

// ¿Hay teléfono configurado y túnel vivo? Lo decimos en pantalla, no en la consola.
function checkPhone() {
  return fetch("/twilio/health")
    .then((r) => r.json())
    .then((h) => {
      view.setPhoneNumber(h.number ? `teléfono: ${h.number}` : "teléfono: no configurado");
      if (h.ready) {
        view.setCallButtonEnabled(true);
        view.setHint(`Llamá a ${h.number} y dale el encargo a Volta.`);
      } else if (h.missing.length) {
        view.setPhoneState(`falta en .env: ${h.missing.join(", ")}`, "err");
        view.setHint("Sin teléfono: usá el modo navegador.");
      } else if (h.tunnel === "down") {
        // Sin túnel, Twilio no nos alcanza: la llamada muere con "application error".
        view.setPhoneState("túnel caído — arrancá ngrok", "err");
        view.setHint("Twilio no puede alcanzar esta máquina. Revisá el túnel.");
      }
    })
    .catch(() => view.setPhoneState("no pude consultar /twilio/health", "err"));
}

async function callCarrier() {
  const to = el.carrierNum.value.replace(/[^\d+]/g, "");
  if (!/^\+[1-9]\d{6,15}$/.test(to)) {
    view.setPhoneState("número inválido: usá formato +5215512345678", "err");
    return;
  }
  view.setCallButtonEnabled(false);
  view.setPhoneState("marcando…");
  try {
    const res = await fetch("/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to,
        mode: "negotiate",
        carrier: el.carrierName.value || undefined,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "no se pudo llamar");
    activeCallSid = body.sid;
    view.setHangupVisible(true);
    view.setPhoneState(`llamando a ${to}…`, "live");
  } catch (e) {
    view.setPhoneState(e.message, "err");
  } finally {
    view.setCallButtonEnabled(true);
  }
}

async function hangupCall() {
  if (!activeCallSid) return;
  try {
    await fetch(`/call/${activeCallSid}/hangup`, { method: "POST" });
  } catch {}
  view.setHangupVisible(false);
}

// --- modo navegador (fallback sin teléfono) -----------------------------------
async function startMic() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Sin conexión con el backend. Recargá la página.");
  }
  el.startBtn.disabled = true;
  micMode = true;
  await startCapture((audio) => send({ type: "audio", audio }));
  send({ type: "start", mode: "intake" }); // Fase 0: hablar con el cliente
  view.setPhase("intake");
  el.stopBtn.disabled = false;
}

// Cierra la llamada del MICRÓFONO. El socket del dashboard queda vivo: seguimos
// viendo los eventos de las llamadas telefónicas.
function stopMic() {
  send({ type: "stop" });
  micMode = false;
  stopCapture();
  el.startBtn.disabled = false;
  el.stopBtn.disabled = true;
  el.forceCutBtn.hidden = true;
  view.hideIncomingCall();
  view.setPhase("idle");
}

// El intake terminó: dejamos el mic vivo y simulamos que Volta llama al carrier.
function answerCall() {
  view.hideIncomingCall();
  clearAudio();
  view.setPhase("negotiate");
  view.addMessage("user", "— atendiste la llamada (sos el carrier) —");
  send({ type: "start", mode: "negotiate" });
}

// Corte manual del intake (si Volta no llama end_intake sola).
function forceCut() {
  el.forceCutBtn.hidden = true;
  send({ type: "stop" });
  view.addMessage("agent", "— intake cortado manualmente —");
  view.showIncomingCall();
}

// --- arranque ------------------------------------------------------------------
el.startBtn.onclick = () => startMic().catch((e) => { alert(e.message); stopMic(); });
el.stopBtn.onclick = stopMic;
el.answerBtn.onclick = answerCall;
el.forceCutBtn.onclick = forceCut;
el.callBtn.onclick = callCarrier;
el.hangBtn.onclick = hangupCall;
el.carrierNum.onkeydown = (e) => {
  if (e.key === "Enter" && !el.callBtn.disabled) callCarrier();
};

view.loadInitialState();
checkPhone();
connect();
