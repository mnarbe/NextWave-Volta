// Prueba el ciclo completo del recap SIN mandar mail: token, endpoint y el
// camino en que el envío falla (que es el que no debe mentirle al modelo).
import { createApp } from "../http/routes.js";
import { createCall, getCall, findCommitment } from "../store/calls.js";
import { confirmToken, verifyConfirmToken, sendRecap } from "./recap.js";
import { commitmentState } from "../domain/types.js";
import type { Commitment } from "../domain/types.js";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, e = "") =>
  c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${e}`));

const callId = createCall({
  origin: "Port of Manzanillo", destination: "Warehouse in Guadalajara",
  containerNumber: "MSCU1234567", maxPriceMxn: 9000,
  pickupWindowStart: "2026-09-03T08:00", pickupWindowEnd: "2026-09-03T18:00",
  forbiddenConditions: ["prepayment"],
});
const commitment: Commitment = {
  id: "c-test-1", callId, priceMxn: 7400, pickupTime: "2026-09-03T10:00",
  conditions: [], agreedByName: "Juan", createdAt: new Date().toISOString(),
  confirmations: [],
};
getCall(callId)!.commitments.push(commitment);

console.log("\n-- tokens --");
const t = confirmToken("c-test-1", "carrier");
check("token es determinístico", t === confirmToken("c-test-1", "carrier"));
check("distinto por parte", t !== confirmToken("c-test-1", "client"));
check("distinto por compromiso", t !== confirmToken("c-test-2", "carrier"));
check("verifica el válido", verifyConfirmToken("c-test-1", "carrier", t));
check("rechaza el falso", !verifyConfirmToken("c-test-1", "carrier", "deadbeef"));
check("rechaza cruzar partes", !verifyConfirmToken("c-test-1", "client", t));

console.log("\n-- sin API key: NO puede decir que mandó --");
const r = await sendRecap(commitment, getCall(callId)!.mandate);
check("status failed", r.status === "failed", JSON.stringify(r));
check("dice por qué", r.error === "email_not_configured", r.error);
check("estado = pending_recap", commitmentState(commitment) === "pending_recap");

console.log("\n-- endpoint de confirmación --");
const server = createApp().listen(3488);
const base = "http://localhost:3488";
const get = async (u: string) => { const res = await fetch(base + u); return { code: res.status, body: await res.text() }; };

check("token inválido -> 403", (await get(`/confirm/c-test-1/carrier?t=nope`)).code === 403);
check("parte inválida -> 400", (await get(`/confirm/c-test-1/nadie?t=${t}`)).code === 400);
check("inexistente -> 404", (await get(`/confirm/c-nope/carrier?t=${confirmToken("c-nope","carrier")}`)).code === 404);

// Sin recap enviado, un click NO alcanza para que el compromiso cuente:
// en la realidad el link ni siquiera existiría.
const forced = await get(`/confirm/c-test-1/carrier?t=${t}`);
check("acepta el click", forced.code === 200);
check("pero sigue pending_recap sin recap", commitmentState(commitment) === "pending_recap");
commitment.confirmations.length = 0;

// A partir de acá, el camino real: el recap salió.
commitment.recap = { status: "sent", sentAt: new Date().toISOString(), messageIds: ["re_1","re_2"], to: ["a@b.com","a@b.com"] };
check("recap enviado -> recorded", commitmentState(commitment) === "recorded");

const first = await get(`/confirm/c-test-1/carrier?t=${t}`);
check("carrier confirma -> 200", first.code === 200);
check("dice que espera al cliente", first.body.includes("waiting on the client"), first.body.slice(0,200));
check("sigue recorded con uno solo", commitmentState(commitment) === "recorded");

const again = await get(`/confirm/c-test-1/carrier?t=${t}`);
check("reclick es idempotente", again.code === 200 && commitment.confirmations.length === 1);

const second = await get(`/confirm/c-test-1/client?t=${confirmToken("c-test-1","client")}`);
check("cliente confirma -> final", second.body.includes("final"), second.body.slice(0,200));
check("estado = confirmed", commitmentState(commitment) === "confirmed");
check("quedaron las 2 confirmaciones", commitment.confirmations.length === 2);

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
