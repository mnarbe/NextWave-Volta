// No-regresión del modo navegador: el transporte viejo tiene que seguir andando.
import WebSocket from "ws";
let pass = 0, fail = 0;
const check = (n: string, c: boolean, e = "") =>
  c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${e}`));

const ws = new WebSocket("ws://localhost:3399/ws");
const msgs: any[] = [];
ws.on("message", (r) => { try { msgs.push(JSON.parse(r.toString())); } catch {} });

ws.on("open", async () => {
  ws.send(JSON.stringify({ type: "start", mode: "intake" }));
  await new Promise((r) => setTimeout(r, 600));
  const started = msgs.find((m) => m.type === "started");
  check("responde 'started'", Boolean(started), JSON.stringify(msgs.slice(0, 3)));
  check("modo intake sin mandato", started?.mode === "intake" && started?.mandate === null);
  check("devuelve callId", typeof started?.callId === "string" && started.callId.length > 10);

  const call = await (await fetch(`http://localhost:3399/calls/${started.callId}`)).json();
  check("la llamada existe en el store", call.callId === started.callId);

  // Modo negociación: debe caer al mandato default (no hay capturado).
  const ws2 = new WebSocket("ws://localhost:3399/ws");
  const m2: any[] = [];
  ws2.on("message", (r) => { try { m2.push(JSON.parse(r.toString())); } catch {} });
  ws2.on("open", async () => {
    ws2.send(JSON.stringify({ type: "start", mode: "negotiate" }));
    await new Promise((r) => setTimeout(r, 600));
    const s2 = m2.find((m) => m.type === "started");
    check("modo negotiate trae mandato", s2?.mandate?.maxPriceMxn === 9000, JSON.stringify(s2));
    check("negotiate usa el default", s2?.mandate?.origin === "Port of Manzanillo");
    ws.close(); ws2.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
});
