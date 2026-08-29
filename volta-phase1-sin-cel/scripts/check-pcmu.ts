// -----------------------------------------------------------------------------
// scripts/check-pcmu.ts   ->   npm run check:pcmu
//
// Verifica contra la API real que la sesión Realtime acepta G.711 μ-law
// ({ type: "audio/pcmu" }), que es lo que hace posible enchufar Twilio sin
// transcodificar. Es la única pieza del stack telefónico que no se puede
// validar sin la API key, así que corré esto ANTES de la primera llamada.
//
// Si fallara, el plan B es audio/pcm 24kHz + resampleo μ-law <-> PCM, y el
// cambio queda contenido en src/twilio/mediaStream.ts.
// -----------------------------------------------------------------------------
import WebSocket from "ws";
import { config } from "../src/config.js";

const format = { type: "audio/pcmu" };

const ws = new WebSocket(
  `wss://api.openai.com/v1/realtime?model=${config.openaiRealtimeModel}`,
  { headers: { Authorization: `Bearer ${config.openaiApiKey}` } }
);

let settled = false;
const done = (ok: boolean, msg: string) => {
  if (settled) return;
  settled = true;
  console.log(ok ? `\n✅ ${msg}` : `\n❌ ${msg}`);
  try { ws.close(); } catch {}
  process.exit(ok ? 0 : 1);
};

ws.on("open", () => {
  console.log(`Modelo: ${config.openaiRealtimeModel}`);
  console.log(`Probando audio.input/output.format = ${JSON.stringify(format)} ...`);
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      type: "realtime",
      model: config.openaiRealtimeModel,
      output_modalities: ["audio"],
      audio: {
        input: { format, turn_detection: { type: "server_vad" } },
        output: { format, voice: "alloy" },
      },
    },
  }));
});

ws.on("message", (raw) => {
  const evt = JSON.parse(raw.toString());
  if (evt.type === "session.updated") {
    const applied = evt.session?.audio?.input?.format;
    console.log(`La API devolvió: ${JSON.stringify(applied)}`);
    done(true, "audio/pcmu ACEPTADO. Twilio se enchufa sin transcodificar.");
  }
  if (evt.type === "error") {
    console.error(JSON.stringify(evt.error, null, 2));
    done(false, "audio/pcmu RECHAZADO. Usá el plan B (pcm24 + resampleo).");
  }
});

ws.on("error", (err) => done(false, `No se pudo conectar: ${err}`));
setTimeout(() => done(false, "Timeout esperando session.updated."), 15000);
