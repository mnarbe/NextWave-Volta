// -----------------------------------------------------------------------------
// twilioStream.ts
// El transporte "teléfono": WebSocket /twilio/media <-> OpenAI Realtime.
//
// Protocolo de Twilio Media Streams (bidireccional, <Connect><Stream>):
//   Twilio -> nosotros: {event:"connected"} , {event:"start", start:{streamSid,
//                       callSid, ...}} , {event:"media", media:{payload}} ,
//                       {event:"mark", mark:{name}} , {event:"stop"}
//   nosotros -> Twilio: {event:"media", streamSid, media:{payload}}
//                       {event:"clear", streamSid}   (cortar lo encolado)
//                       {event:"mark",  streamSid, mark:{name}}  (marcador que
//                       Twilio nos devuelve cuando terminó de reproducir todo
//                       lo enviado hasta ese punto)
//
// El payload es base64 de G.711 μ-law 8 kHz — el MISMO formato que le pedimos a
// OpenAI (audio/pcmu), así que va y viene sin tocarlo.
// -----------------------------------------------------------------------------
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";

import { log } from "../store.js";
import { publish } from "../bus.js";
import { startSession } from "../session.js";
import type { Phase } from "./realtime.js";

// Nombre del marcador que usamos para colgar recién cuando terminó de sonar la
// frase de cierre de Volta.
const FINAL_MARK = "volta-final";
// Si Twilio nunca nos devuelve el mark (llamada cortada, red), colgamos igual.
const FINAL_TIMEOUT_MS = 20_000;

export function handleTwilioMedia(ws: WebSocket, req: IncomingMessage) {
  const url = new URL(req.url || "/", "http://localhost");
  const mode: Phase = url.searchParams.get("mode") === "negotiate" ? "negotiate" : "intake";
  const carrierHint = url.searchParams.get("carrier") || undefined;

  let streamSid = "";
  let callSid = "";
  let session: ReturnType<typeof startSession> | null = null;
  let finalTimer: NodeJS.Timeout | null = null;
  let closing = false;

  const toTwilio = (obj: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  const shutdown = () => {
    if (closing) return;
    closing = true;
    if (finalTimer) clearTimeout(finalTimer);
    session?.bridge.close();
    // Cerrar el WebSocket termina el <Connect><Stream>; como no hay más TwiML
    // después, Twilio cuelga la llamada.
    try {
      ws.close();
    } catch {
      /* noop */
    }
    if (session) {
      publish({
        kind: "phone_call_ended",
        callId: session.callId,
        transport: "phone",
        data: { callSid },
      });
    }
  };

  ws.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      // Twilio abrió el socket; todavía no hay audio ni streamSid.
      case "connected":
        break;

      // Arrancó el stream: acá sí tenemos streamSid/callSid y podemos levantar
      // el puente con OpenAI.
      case "start": {
        streamSid = msg.start?.streamSid || msg.streamSid || "";
        callSid = msg.start?.callSid || "";

        session = startSession({
          mode,
          transport: "phone",
          // Audio de Volta -> Twilio -> auricular de la persona.
          sendAudio: (payload) =>
            toTwilio({ event: "media", streamSid, media: { payload } }),
          // Barge-in: tiramos lo que Twilio tenga encolado sin reproducir.
          clearAudio: () => toTwilio({ event: "clear", streamSid }),
          // Volta dijo su cierre: mandamos un mark y colgamos cuando vuelva
          // (es decir, cuando el audio terminó de sonar del otro lado).
          onFinal: () => {
            toTwilio({ event: "mark", streamSid, mark: { name: FINAL_MARK } });
            finalTimer = setTimeout(shutdown, FINAL_TIMEOUT_MS);
          },
        });

        log(session.callId, "call_started", {
          transport: "phone",
          mode,
          callSid,
          from: msg.start?.customParameters?.from,
        });
        publish({
          kind: "phone_call_started",
          callId: session.callId,
          transport: "phone",
          data: { callSid, mode, carrier: carrierHint },
        });
        break;
      }

      // Audio de la persona -> OpenAI. Passthrough: ya es μ-law 8 kHz base64.
      case "media":
        if (msg.media?.payload) session?.bridge.appendAudio(msg.media.payload);
        break;

      // Twilio nos devuelve el marcador cuando terminó de reproducir todo lo
      // que le mandamos antes de ponerlo. Ese es el momento de colgar.
      case "mark":
        if (msg.mark?.name === FINAL_MARK) shutdown();
        break;

      // La llamada se terminó (colgaron del otro lado, o colgamos nosotros).
      case "stop":
        shutdown();
        break;
    }
  });

  ws.on("close", () => shutdown());
  ws.on("error", () => shutdown());
}
