// -----------------------------------------------------------------------------
// twilio/mediaStream.ts
// Adapta el WebSocket de Twilio Media Streams al RealtimeBridge.
// Es el equivalente telefónico del handler del navegador en server.ts.
//
// Twilio manda:  connected -> start -> media* (+ dtmf, mark) -> stop
// Nosotros mandamos de vuelta: media, mark, clear.
//
// El audio es μ-law 8kHz base64 en los dos sentidos, que es exactamente lo que
// acepta la API GA con format {type:"audio/pcmu"}. No se transcodifica nada.
// -----------------------------------------------------------------------------
import type WebSocket from "ws";
import { RealtimeBridge, type Phase } from "../realtime.js";
import { getCall, log, setAudioClock, endCall } from "../store.js";
import { CallRecorder } from "../audio/recorder.js";

export function handleTwilioStream(ws: WebSocket) {
  let bridge: RealtimeBridge | null = null;
  let recorder: CallRecorder | null = null;
  let streamSid = "";
  let callId = "";

  // Reloj de la llamada: ms desde el inicio del stream, que Twilio nos regala
  // en cada frame entrante. Es monótono y gratis; lo usamos para todo
  // (log.audioMs, agreedAtAudioMs y el cálculo del barge-in).
  let latestMediaTimestamp = 0;
  // Cuándo (en ese mismo reloj) empezó a sonar la respuesta actual de Volta.
  let responseStartTimestamp: number | null = null;
  // Marks que mandamos y todavía no confirmó Twilio = audio aún en su buffer.
  let markQueue: string[] = [];
  // Tras un barge-in pueden seguir llegando deltas que OpenAI ya tenía en vuelo:
  // hay que tirarlos, no alcanza con vaciar el buffer de Twilio.
  let discardDeltas = false;
  let markSeq = 0;

  const toTwilio = (obj: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  const cleanup = () => {
    bridge?.close();
    bridge = null;
    recorder?.close();
    recorder = null;
    if (callId) endCall(callId);
  };

  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "connected":
        // Solo handshake: todavía no sabemos de qué llamada se trata.
        break;

      // El único lugar donde llegan streamSid y los <Parameter> del TwiML.
      // Recién acá podemos construir el bridge.
      case "start": {
        streamSid = msg.streamSid;
        const params = msg.start?.customParameters || {};
        callId = params.callId || "";
        const phase: Phase = params.mode === "negotiate" ? "negotiate" : "intake";

        const call = getCall(callId);
        if (!call) {
          // Server reiniciado o callId inválido: no hay contexto que usar.
          console.error(`[twilio] stream para callId desconocido: ${callId}`);
          ws.close();
          return;
        }

        log(callId, "call_started", {
          side: "twilio",
          streamSid,
          callSid: msg.start?.callSid,
          phase,
        });

        setAudioClock(callId, () => latestMediaTimestamp);
        recorder = new CallRecorder(callId);

        bridge = new RealtimeBridge({
          callId,
          phase,
          audioFormat: "pcmu", // <- la única diferencia con el navegador
          cb: {
            sendAudio: (b64) => {
              if (discardDeltas) return;
              toTwilio({ event: "media", streamSid, media: { payload: b64 } });
              // Un mark por chunk: cuando Twilio nos lo devuelve, ese audio ya sonó.
              const name = `m${++markSeq}`;
              markQueue.push(name);
              toTwilio({ event: "mark", streamSid, mark: { name } });
              recorder?.writeOutbound(b64);
            },
            clearAudio: () => {
              discardDeltas = true;
              toTwilio({ event: "clear", streamSid });
              markQueue = [];
              responseStartTimestamp = null;
            },
            // Cuánto se escuchó realmente de la respuesta actual.
            playedMs: () =>
              responseStartTimestamp === null
                ? 0
                : latestMediaTimestamp - responseStartTimestamp,
            onResponseStart: () => {
              discardDeltas = false;
              responseStartTimestamp = latestMediaTimestamp;
            },
            // En el teléfono no hay panel, pero sí nos importa cuándo Volta da
            // por terminada la conversación: el bridge se cierra solo a los
            // 3.5s y, si no colgamos nosotros, la llamada sigue abierta con
            // silencio hasta que corte la otra persona.
            onEvent: (kind) => {
              if (kind === "intake_done" || kind === "negotiation_done") {
                setTimeout(() => {
                  try {
                    ws.close();
                  } catch {
                    /* noop */
                  }
                }, 4000);
              }
            },
          },
        });
        break;
      }

      case "media": {
        latestMediaTimestamp = Number(msg.media?.timestamp) || latestMediaTimestamp;
        const payload = msg.media?.payload;
        if (!payload) break;
        bridge?.appendAudio(payload); // ya viene en base64 μ-law
        recorder?.writeInbound(payload);
        break;
      }

      // Twilio confirma que un chunk terminó de sonar.
      case "mark": {
        const name = msg.mark?.name;
        const i = markQueue.indexOf(name);
        if (i >= 0) markQueue.splice(0, i + 1);
        break;
      }

      case "dtmf":
        if (callId) log(callId, "dtmf", { digit: msg.dtmf?.digit });
        break;

      case "stop":
        if (callId) log(callId, "call_ended", { side: "twilio", audioMs: latestMediaTimestamp });
        cleanup();
        break;
    }
  });

  ws.on("close", () => {
    if (callId) log(callId, "call_ended", { side: "twilio_ws_close" });
    cleanup();
  });

  ws.on("error", (err) => {
    if (callId) log(callId, "error", { where: "twilio_ws", err: String(err) });
    cleanup();
  });
}
