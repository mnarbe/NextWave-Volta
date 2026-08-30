// ============================================================================
// client.js — the dashboard's wiring.
// Owner: call.
//
// Opens the WebSocket to the backend, translates each event into a render.js
// call, and drives the phone buttons (dial / hang up) plus browser mode. It
// draws nothing itself: everything visual goes through render.js.
// ============================================================================
import * as view from "./render.js";
import { startCapture, stopCapture, playAudio, clearAudio } from "./audio.js";

const el = view.ui; // the page's elements

let ws = null;
let micMode = false;      // is this tab acting as the line, via microphone?
let activeCallSid = null; // phone call in flight (for the Hang up button)
let roundMode = false;    // a parallel carrier round is running

// --- connection --------------------------------------------------------------
// Connects on page load, WITHOUT a microphone: it listens to the events of every
// call (phone or browser) and paints the screen.
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => view.setConnected(true);
  ws.onmessage = onServerMessage;
  ws.onclose = () => {
    view.setConnected(false);
    ws = null;
    if (micMode) stopMic();
    setTimeout(connect, 1500); // the dashboard reconnects on its own
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// --- events from the backend --------------------------------------------------
function onServerMessage(ev) {
  const msg = JSON.parse(ev.data);

  // Audio only arrives in browser mode (over the phone Twilio plays it).
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

    // --- round --------------------------------------------------------------
    // One scripted carrier said a line (Volta or the dispatcher persona).
    case "carrier_transcript": {
      const d = msg.data || {};
      view.addMessage(d.role === "volta" ? "agent" : "user", `[${d.carrierName}] ${d.text}`);
      break;
    }

    case "round_done":
      roundMode = false;
      view.renderRoundResult(msg.data);
      view.setHint((msg.data && msg.data.reason) || "Round complete.");
      view.addTool("tool_result", { name: "round_done", result: msg.data });
      break;

    // --- phone calls ----------------------------------------------------------
    case "phone_call_started": {
      const mode = (msg.data && msg.data.mode) || "intake";
      view.setPhoneState(
        mode === "negotiate" ? "on a call with the carrier" : "on a call with the client",
        "live"
      );
      activeCallSid = (msg.data && msg.data.callSid) || null;
      view.setHangupVisible(Boolean(activeCallSid));
      view.setPhase(mode === "negotiate" ? "negotiate" : "intake");
      break;
    }

    case "phone_call_ended":
      view.setPhoneState("no call");
      activeCallSid = null;
      view.setHangupVisible(false);
      view.setPhase("idle");
      break;

    case "call_started":
      if (phone) view.addTool("tool_result", { name: "call started", result: msg.data });
      // A round carrier (sim or the human placeholder) just opened: show its card.
      if (msg.data && msg.data.carrier) view.refreshNegotiations();
      break;

    // --- business -------------------------------------------------------------
    case "mandate_captured":
      view.renderMandate(msg.data, { justCaptured: true });
      view.addTool("tool_result", { name: "mandate_captured", result: msg.data });
      view.clearNegotiations(); // new job: clear the carrier panel
      if (!phone) el.forceCutBtn.hidden = false; // browser-mode safety net
      break;

    case "carrier_offer":
      if (msg.data && msg.data.offers) view.upsertNeg(msg.data);
      else view.refreshNegotiations();
      view.addTool("tool_result", { name: "log_carrier_offer", result: msg.data });
      break;

    case "intake_done":
      el.forceCutBtn.hidden = true;
      view.setMandateDone("Intake complete — Volta hung up with the client.");
      view.addMessage("agent", "— end of intake —");
      // Over the phone the next step is dialling the carrier; in browser mode we
      // simulate the inbound call like before.
      if (phone) {
        view.setHint("Now call the carrier from the bar above.");
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
      const who = msg.data && msg.data.carrier && msg.data.carrier.carrierName;
      view.addMessage(
        "agent",
        `— ${who ? who + ": " : ""}end of negotiation · ${outcome === "deal" ? "deal closed" : "no deal"} —`
      );
      // Only the browser-mic line should stop the mic; sim closings must not.
      if (msg.transport === "browser") setTimeout(stopMic, 900);
      break;
    }

    default:
      view.addTool(msg.kind, msg.data);
  }
}

// --- phone --------------------------------------------------------------------

// Is the phone configured and the tunnel alive? We say it on screen, not in the
// console.
function checkPhone() {
  return fetch("/twilio/health")
    .then((r) => r.json())
    .then((h) => {
      view.setPhoneNumber(h.number ? `phone: ${h.number}` : "phone: not configured");
      if (h.ready) {
        view.setCallButtonEnabled(true);
        view.setHint(`Call ${h.number} and hand Volta the job.`);
      } else if (h.missing.length) {
        view.setPhoneState(`missing in .env: ${h.missing.join(", ")}`, "err");
        view.setHint("No phone: use browser mode.");
      } else if (h.tunnel === "down") {
        // With no tunnel Twilio cannot reach us: the call dies with
        // "an application error has occurred".
        view.setPhoneState("tunnel down — start ngrok", "err");
        view.setHint("Twilio cannot reach this machine. Check the tunnel.");
      }
    })
    .catch(() => view.setPhoneState("could not reach /twilio/health", "err"));
}

async function callCarrier() {
  const to = el.carrierNum.value.replace(/[^\d+]/g, "");
  if (!/^\+[1-9]\d{6,15}$/.test(to)) {
    view.setPhoneState("invalid number: use E.164, e.g. +5215512345678", "err");
    return;
  }
  view.setCallButtonEnabled(false);
  view.setPhoneState("dialling…");
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
    if (!res.ok) throw new Error(body.error || "could not place the call");
    activeCallSid = body.sid;
    view.setHangupVisible(true);
    view.setPhoneState(`calling ${to}…`, "live");
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

// --- browser mode (fallback without the phone) --------------------------------
async function startMic() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("No connection to the backend. Reload the page.");
  }
  el.startBtn.disabled = true;
  micMode = true;
  await startCapture((audio) => send({ type: "audio", audio }));
  send({ type: "start", mode: "intake" }); // Phase 0: talk to the client
  view.setPhase("intake");
  el.stopBtn.disabled = false;
}

// Closes the MICROPHONE call. The dashboard socket stays alive: we keep seeing
// the events from phone calls.
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

// Intake is over (or a round is waiting for its human carrier): take Volta's
// call as the carrier. Make sure the mic is live first — in a round the user may
// not have gone through browser-mode intake.
async function answerCall() {
  view.hideIncomingCall();
  clearAudio();
  if (!micMode) {
    micMode = true;
    await startCapture((audio) => send({ type: "audio", audio }));
    el.startBtn.disabled = true;
    el.stopBtn.disabled = false;
  }
  view.setPhase("negotiate");
  view.addMessage("user", "— you answered the call (you are the carrier) —");
  send({ type: "start", mode: "negotiate" });
}

// --- round -------------------------------------------------------------------
// Kick off a parallel round: the scripted carriers start negotiating on the
// backend right away; the human carrier (one of us) joins per the .env setting.
async function startRound() {
  el.roundBtn.disabled = true;
  view.clearNegotiations();
  try {
    const res = await fetch("/round/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "could not start the round");
    roundMode = true;
    view.refreshNegotiations();
    if (body.humanCarrierTransport === "phone") {
      view.setHint("Round running — call the human carrier's number from the bar above.");
      el.carrierNum.focus();
    } else {
      view.setHint("Round running — you are the human carrier. Click Answer to take Volta's call.");
      view.showIncomingCall();
    }
  } catch (e) {
    alert(e.message);
  } finally {
    el.roundBtn.disabled = false;
  }
}

// Manual intake cut (if Volta does not call end_intake on its own).
function forceCut() {
  el.forceCutBtn.hidden = true;
  send({ type: "stop" });
  view.addMessage("agent", "— intake cut manually —");
  view.showIncomingCall();
}

// --- boot ----------------------------------------------------------------------
el.startBtn.onclick = () => startMic().catch((e) => { alert(e.message); stopMic(); });
el.stopBtn.onclick = stopMic;
el.roundBtn.onclick = startRound;
el.answerBtn.onclick = () => answerCall().catch((e) => alert(e.message));
el.forceCutBtn.onclick = forceCut;
el.callBtn.onclick = callCarrier;
el.hangBtn.onclick = hangupCall;
el.carrierNum.onkeydown = (e) => {
  if (e.key === "Enter" && !el.callBtn.disabled) callCarrier();
};

view.loadInitialState();
checkPhone();
connect();
