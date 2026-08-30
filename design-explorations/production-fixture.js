import {
  addMessage,
  renderMandate,
  renderRoundResult,
  setConnected,
  setHint,
  setPhase,
  setPhoneNumber,
  setPhoneState,
  upsertNeg,
} from "/public/js/render.js";

const mandate = {
  origin: "Manzanillo",
  destination: "Guadalajara",
  containerNumber: "MSCU1234567",
  maxPriceMxn: 9000,
  pickupWindowStart: "2026-09-03T08:00:00-06:00",
  pickupWindowEnd: "2026-09-03T18:00:00-06:00",
  forbiddenConditions: ["prepayment", "no insurance"],
  capturedAt: "2026-08-30T09:12:00-06:00",
};

const fixtureMode = new URLSearchParams(window.location.search).get("state") || "deal";

const records = [
  {
    callId: "round:sim-norte",
    carrierId: "sim-norte",
    carrierName: "Fletes del Norte",
    kind: "sim",
    startedAt: "2026-08-30T09:24:00-06:00",
    status: "deal",
    refusals: 1,
    offers: [{ ts: "2026-08-30T09:27:00-06:00", priceMxn: 8700, pickupTime: "2026-09-03T15:00:00-06:00", pickupDelayDays: 0, conditions: [] }],
    latest: { priceMxn: 8700, pickupTime: "2026-09-03T15:00:00-06:00", pickupDelayDays: 0, conditions: [] },
    final: { outcome: "deal", priceMxn: 8700, pickupTime: "2026-09-03T15:00:00-06:00", pickupDelayDays: 0, conditionsToRelay: [], priceWithinCap: true, decidedAt: "2026-08-30T09:27:00-06:00" },
  },
  {
    callId: "round:sim-pacifico",
    carrierId: "sim-pacifico",
    carrierName: "Transportes del Pacífico",
    kind: "sim",
    startedAt: "2026-08-30T09:24:10-06:00",
    status: "deal",
    refusals: 2,
    offers: [{ ts: "2026-08-30T09:28:00-06:00", priceMxn: 8250, pickupTime: "2026-09-04T09:00:00-06:00", pickupDelayDays: 1, delayNote: "después de la ventana", conditions: [] }],
    latest: { priceMxn: 8250, pickupTime: "2026-09-04T09:00:00-06:00", pickupDelayDays: 1, delayNote: "después de la ventana", conditions: [] },
    final: { outcome: "deal", priceMxn: 8250, pickupTime: "2026-09-04T09:00:00-06:00", pickupDelayDays: 1, delayNote: "después de la ventana", conditionsToRelay: [], priceWithinCap: true, decidedAt: "2026-08-30T09:29:00-06:00" },
  },
  {
    callId: "round:human-1",
    carrierId: "human-1",
    carrierName: "You (carrier)",
    kind: "human",
    startedAt: "2026-08-30T09:24:20-06:00",
    status: "deal",
    refusals: 2,
    offers: [{ ts: "2026-08-30T09:30:00-06:00", priceMxn: 9400, pickupTime: "2026-09-03T16:00:00-06:00", pickupDelayDays: 0, conditions: [] }],
    latest: { priceMxn: 9400, pickupTime: "2026-09-03T16:00:00-06:00", pickupDelayDays: 0, conditions: [] },
    final: { outcome: "deal", priceMxn: 9400, pickupTime: "2026-09-03T16:00:00-06:00", pickupDelayDays: 0, conditionsToRelay: [], priceWithinCap: false, decidedAt: "2026-08-30T09:30:00-06:00" },
  },
];

if (fixtureMode === "live") {
  records[2].status = "in_progress";
  records[2].final = null;
}

renderMandate(mandate);
for (const record of records) upsertNeg(record);

addMessage("agent", "[Transportes del Pacífico] Hola, gracias por tu oferta. ¿Podés confirmar el horario de retiro?");
addMessage("user", "[Transportes del Pacífico] Mi oferta es 8.250 MXN, pero el retiro sería después de las 18:00.");
addMessage("agent", "[Transportes del Pacífico] Ese horario queda fuera de la ventana autorizada; no puedo adjudicar esta oferta.");

const successfulDecision = {
  outcome: "deal",
  winnerCallId: "round:sim-norte",
  ranking: [
    { callId: "round:sim-norte", carrierName: "Fletes del Norte", eligible: true, outcome: "deal", priceMxn: 8700, pickupDelayDays: 0, conditionCount: 0, disqualifiers: [] },
    { callId: "round:sim-pacifico", carrierName: "Transportes del Pacífico", eligible: false, outcome: "deal", priceMxn: 8250, pickupDelayDays: 1, conditionCount: 0, disqualifiers: ["pickup 1 day past the window"] },
    { callId: "round:human-1", carrierName: "You (carrier)", eligible: false, outcome: "deal", priceMxn: 9400, pickupDelayDays: 0, conditionCount: 0, disqualifiers: ["price 9400 MXN over cap 9000 MXN"] },
  ],
  needsHumanReview: [
    { callId: "round:sim-pacifico", carrierName: "Transportes del Pacífico", why: "pickup 1 day past the window" },
    { callId: "round:human-1", carrierName: "You (carrier)", why: "price 9400 MXN over cap 9000 MXN" },
  ],
  reason: "Fletes del Norte gana con la menor oferta limpia.",
};

const reviewDecision = {
  outcome: "no_deal",
  winnerCallId: null,
  ranking: successfulDecision.ranking.map((entry) => ({
    ...entry,
    eligible: false,
    disqualifiers: entry.disqualifiers.length ? entry.disqualifiers : ["insurance confirmation pending"],
  })),
  needsHumanReview: [
    { callId: "round:sim-norte", carrierName: "Fletes del Norte", why: "confirmación de seguro pendiente" },
    { callId: "round:sim-pacifico", carrierName: "Transportes del Pacífico", why: "retiro fuera de ventana" },
  ],
  reason: "Ninguna oferta cumple todo el mandato sin confirmar una excepción.",
};

if (fixtureMode !== "live") renderRoundResult(fixtureMode === "review" ? reviewDecision : successfulDecision);

setConnected(fixtureMode !== "offline");
setPhoneNumber("Teléfono de demo protegido");
setPhoneState(fixtureMode === "live" ? "Llamada activa con carrier" : "Ronda finalizada");
setHint(fixtureMode === "offline" ? "Backend desconectado." : fixtureMode === "review" ? "Ronda en espera de intervención humana." : fixtureMode === "live" ? "Nueva oferta recibida · negociación en curso." : "Ronda cerrada · ganador seleccionado.");
if (fixtureMode === "live") setPhase("negotiate");

window.setTimeout(() => {
  document.querySelector(`[data-call-id="${fixtureMode === "live" ? "round:human-1" : "round:sim-pacifico"}"]`)?.click();
}, 250);
