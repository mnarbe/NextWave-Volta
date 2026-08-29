// Test de integración contra un server ya levantado en :3399.
// Simula una sesión completa de Twilio Media Streams.
import WebSocket from "ws";

const BASE = "http://localhost:3399";
let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra = "") =>
  c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${extra}`));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ¿Se acepta el upgrade en este path?
function tryUpgrade(path: string): Promise<"open" | "rejected"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:3399${path}`);
    const done = (r: "open" | "rejected") => { try { ws.close(); } catch {} resolve(r); };
    ws.on("open", () => done("open"));
    ws.on("error", () => done("rejected"));
    setTimeout(() => done("rejected"), 2000);
  });
}

async function main() {
  console.log("\n-- TwiML --");
  const outbound = await (await fetch(`${BASE}/twilio/outbound-twiml?callId=abc-123`)).text();
  check("outbound TwiML usa <Connect><Stream>", outbound.includes("<Connect>") && outbound.includes("<Stream"));
  check("outbound TwiML apunta a wss://", outbound.includes('wss://volta.ngrok-free.app/twilio/media'), outbound);
  check("outbound TwiML lleva el callId", outbound.includes('name="callId" value="abc-123"'), outbound);
  check("outbound TwiML modo negotiate", outbound.includes('name="mode" value="negotiate"'));

  const inboundRes = await fetch(`${BASE}/twilio/inbound`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "From=%2B5213311112222&CallSid=CAtest123",
  });
  const inbound = await inboundRes.text();
  check("inbound responde XML", inboundRes.headers.get("content-type")?.includes("xml") === true);
  // Sin mandato guardado, una llamada entrante es intake.
  check("inbound sin mandato -> intake", inbound.includes('name="mode" value="intake"'), inbound);
  const callId = inbound.match(/name="callId" value="([^"]+)"/)?.[1] || "";
  check("inbound crea un callId", callId.length > 10);

  console.log("\n-- ruteo de upgrades (el punto del noServer) --");
  check("/ws acepta", (await tryUpgrade("/ws")) === "open");
  check("/twilio/media acepta", (await tryUpgrade("/twilio/media")) === "open");
  check("/basura rechaza", (await tryUpgrade("/basura")) === "rejected");

  console.log("\n-- sesión Twilio simulada --");
  const ws = new WebSocket("ws://localhost:3399/twilio/media");
  const sent: any[] = [];
  ws.on("message", (r) => { try { sent.push(JSON.parse(r.toString())); } catch {} });
  await new Promise((r) => ws.on("open", r));

  const streamSid = "MZtest";
  ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  ws.send(JSON.stringify({
    event: "start", sequenceNumber: "1", streamSid,
    start: {
      accountSid: "ACtest", streamSid, callSid: "CAtest123", tracks: ["inbound"],
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      customParameters: { callId, mode: "intake" },
    },
  }));
  await sleep(300);

  // 100 frames de 20ms = 2 segundos de audio.
  const frame = Buffer.alloc(160, 0xff).toString("base64");
  for (let i = 1; i <= 100; i++) {
    ws.send(JSON.stringify({
      event: "media", sequenceNumber: String(i + 1), streamSid,
      media: { track: "inbound", chunk: String(i), timestamp: String(i * 20), payload: frame },
    }));
  }
  await sleep(400);

  const call = await (await fetch(`${BASE}/calls/${callId}`)).json();
  const started = call.log.find((e: any) => e.kind === "call_started" && e.data?.side === "twilio");
  check("loguea call_started del stream", Boolean(started), JSON.stringify(call.log.map((l: any) => l.kind)));

  // El reloj de audio tiene que haber avanzado ~2000ms.
  const stamped = call.log.filter((e: any) => typeof e.audioMs === "number");
  const maxMs = Math.max(0, ...stamped.map((e: any) => e.audioMs));
  check("el reloj de audio avanza con media.timestamp", maxMs >= 1900 && maxMs <= 2000, `maxMs=${maxMs}`);

  ws.send(JSON.stringify({ event: "stop", streamSid, stop: { accountSid: "ACtest", callSid: "CAtest123" } }));
  await sleep(300);
  ws.close();

  const after = await (await fetch(`${BASE}/calls/${callId}`)).json();
  check("loguea call_ended", after.log.some((e: any) => e.kind === "call_ended"));

  console.log("\n-- grabación --");
  const fs = await import("node:fs");
  const dir = new URL(`../data/audio/${callId}/`, import.meta.url).pathname;
  check("escribió in.wav", fs.existsSync(`${dir}in.wav`));
  const size = fs.existsSync(`${dir}in.wav`) ? fs.statSync(`${dir}in.wav`).size : 0;
  // 100 frames * 160 bytes = 16000 bytes = 2s, + 58 de header.
  check("in.wav tiene 2s de audio", size === 16058, `size=${size}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
