// -----------------------------------------------------------------------------
// scripts/fake-twilio.mjs
// Se hace pasar por Twilio: abre /twilio/media, manda el handshake
// (connected + start) y silencio μ-law, y guarda el audio que devuelve Volta en
// volta-greeting.wav (G.711, se escucha con cualquier reproductor).
//
// Sirve para probar el camino completo del audio SIN gastar una llamada real ni
// depender de la señal del celular. Con el server corriendo:
//   npm run test:stream
// -----------------------------------------------------------------------------
import WebSocket from "ws";
import fs from "node:fs";

// Por defecto pega en local; pasale la URL pública para probar el túnel entero
// (es el mismo camino que va a usar Twilio):
//   npm run test:stream -- wss://tu-tunel.ngrok-free.dev/twilio/media?mode=intake
const target = process.argv[2] || "ws://localhost:3000/twilio/media?mode=intake";
console.log(`-> ${target}`);
const ws = new WebSocket(target);
const streamSid = "MZfaketest0000000000000000000000";
let frames = 0;
let bytes = 0;
const chunks = [];

ws.on("open", () => {
  console.log("conectado");
  ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  ws.send(
    JSON.stringify({
      event: "start",
      sequenceNumber: "1",
      streamSid,
      start: {
        streamSid,
        accountSid: "ACfake",
        callSid: "CAfake",
        tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      },
    })
  );
  // Silencio μ-law (0xFF) para que el stream de entrada no esté vacío.
  const silence = Buffer.alloc(160, 0xff).toString("base64");
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return clearInterval(timer);
    ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: silence } }));
  }, 20);
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.event === "media") {
    frames++;
    const buf = Buffer.from(msg.media.payload, "base64");
    bytes += buf.length;
    chunks.push(buf);
  } else {
    console.log("<-", JSON.stringify(msg).slice(0, 200));
  }
});

ws.on("close", () => console.log("cerrado"));
ws.on("error", (e) => console.log("error", e.message));

setTimeout(() => {
  console.log(`frames=${frames} bytes=${bytes} segundos_audio=${(bytes / 8000).toFixed(2)}`);
  if (bytes > 0) {
    // WAV con header G.711 μ-law (format 7) — se puede escuchar directo.
    const data = Buffer.concat(chunks);
    const h = Buffer.alloc(58);
    h.write("RIFF", 0); h.writeUInt32LE(50 + data.length, 4); h.write("WAVE", 8);
    h.write("fmt ", 12); h.writeUInt32LE(18, 16); h.writeUInt16LE(7, 20);
    h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28);
    h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.writeUInt16LE(0, 36);
    h.write("fact", 38); h.writeUInt32LE(4, 42); h.writeUInt32LE(data.length, 46);
    h.write("data", 50); h.writeUInt32LE(data.length, 54);
    fs.writeFileSync("volta-greeting.wav", Buffer.concat([h, data]));
    console.log("audio guardado en volta-greeting.wav");
  }
  ws.close();
  process.exit(0);
}, 12000);
