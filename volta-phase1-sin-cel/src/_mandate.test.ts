import { checkMandate, parseInMandateTz, toMandate, negotiationMandate } from "./mandate.js";
import type { Mandate } from "./types.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

const m: Mandate = {
  origin: "Port of Manzanillo",
  destination: "Warehouse in Guadalajara",
  maxPriceMxn: 9000,
  pickupWindowStart: "2026-09-03T08:00",
  pickupWindowEnd: "2026-09-03T18:00",
  forbiddenConditions: ["prepayment", "no insurance"],
};

console.log("\n-- timezone --");
// 08:00 sin zona debe leerse como 08:00 en México (UTC-6) = 14:00Z.
check("naive time -> mandate tz", parseInMandateTz("2026-09-03T08:00") === Date.parse("2026-09-03T14:00:00Z"));
// Un string con Z se respeta tal cual.
check("explicit Z respected", parseInMandateTz("2026-09-03T14:00:00Z") === Date.parse("2026-09-03T14:00:00Z"));
check("explicit offset respected", parseInMandateTz("2026-09-03T08:00:00-06:00") === Date.parse("2026-09-03T14:00:00Z"));
check("space instead of T", parseInMandateTz("2026-09-03 08:00") === Date.parse("2026-09-03T14:00:00Z"));

console.log("\n-- the bug this fixes --");
// El modelo dice 10am México como "...T16:00:00Z". Antes esto caía fuera de la
// ventana naive interpretada como local; ahora entra.
const r1 = checkMandate(m, { priceMxn: 8700, pickupTime: "2026-09-03T16:00:00Z" });
check("10am MX expressed as UTC is allowed", r1.decision === "allowed", JSON.stringify(r1));

console.log("\n-- reglas del mandato --");
check("in-window + under cap", checkMandate(m, { priceMxn: 8700, pickupTime: "2026-09-03T10:00" }).decision === "allowed");
check("over cap rejected", checkMandate(m, { priceMxn: 9800, pickupTime: "2026-09-03T10:00" }).decision === "rejected");
check("before window rejected", checkMandate(m, { priceMxn: 8000, pickupTime: "2026-09-03T06:00" }).decision === "rejected");
check("after window rejected", checkMandate(m, { priceMxn: 8000, pickupTime: "2026-09-04T10:00" }).decision === "rejected");
check("forbidden condition rejected", checkMandate(m, { priceMxn: 8000, pickupTime: "2026-09-03T10:00", conditions: ["50% prepayment upfront"] }).decision === "rejected");
check("unparseable time escalates", checkMandate(m, { priceMxn: 8000, pickupTime: "sometime friday" }).decision === "needs_escalation");
check("boundary start inclusive", checkMandate(m, { priceMxn: 8000, pickupTime: "2026-09-03T08:00" }).decision === "allowed");
check("boundary end inclusive", checkMandate(m, { priceMxn: 8000, pickupTime: "2026-09-03T18:00" }).decision === "allowed");

console.log("\n-- toMandate / negotiationMandate --");
check("null -> null", toMandate(null) === null);
// Sin ventana NO se descarta: se conserva el tope del cliente con ventana abierta.
const noWindow = toMandate({ maxPriceMxn: 7200, currency: "MXN", capturedAt: "" });
check("sin ventana conserva el tope del cliente", noWindow?.maxPriceMxn === 7200, JSON.stringify(noWindow));
check("sin ventana -> ventana abierta", noWindow?.pickupWindowStart === "2000-01-01T00:00");
check("sin tope -> null", toMandate({ maxPriceMxn: 0, currency: "MXN", capturedAt: "" }) === null);
check("un pickup cualquiera entra en ventana abierta",
  checkMandate(noWindow!, { priceMxn: 7000, pickupTime: "2026-11-20T09:00" }).decision === "allowed");
check("pero el tope del cliente se sigue aplicando",
  checkMandate(noWindow!, { priceMxn: 7300, pickupTime: "2026-11-20T09:00" }).decision === "rejected");
const full = toMandate({ maxPriceMxn: 7500, currency: "MXN", origin: "A", destination: "B", pickupWindowStart: "2026-09-03T08:00", pickupWindowEnd: "2026-09-03T18:00", capturedAt: "" });
check("completo -> Mandate", full?.maxPriceMxn === 7500);
check("fallback al default", negotiationMandate(null).source === "default");
check("usa el capturado", negotiationMandate({ maxPriceMxn: 7500, currency: "MXN", pickupWindowStart: "2026-09-03T08:00", pickupWindowEnd: "2026-09-03T18:00", capturedAt: "" }).source === "captured");
// La regresión que esto evita: un mandato capturado sin ventana NO debe caer al
// default de 9000, porque eso descartaría el tope real que dijo el cliente.
check("capturado sin ventana no cae al default",
  negotiationMandate({ maxPriceMxn: 7200, currency: "MXN", capturedAt: "" }).mandate.maxPriceMxn === 7200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
