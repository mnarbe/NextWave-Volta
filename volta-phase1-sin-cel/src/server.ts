// -----------------------------------------------------------------------------
// server.ts
// Tres responsabilidades:
//   1) Servir la UI de prueba (public/index.html) — el fallback sin teléfono.
//   2) Rutas de Twilio (si está configurado): TwiML entrante/saliente + estado.
//   3) Enrutar los upgrades de WebSocket:
//        /ws            -> navegador (PCM16 24kHz)
//        /twilio/media  -> Twilio Media Streams (μ-law 8kHz)
//
// OJO con los WebSocketServer: en ws 8.x, dos instancias creadas con
// { server, path } sobre el MISMO http.Server se pisan — cada una engancha su
// propio listener de "upgrade" y aborta con 400 los paths que no son suyos.
// Por eso van con { noServer: true } y un único router de upgrade acá abajo.
// -----------------------------------------------------------------------------
import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { createCall, getCall } from "./store.js";
import { RealtimeBridge } from "./realtime.js";
import { getMandate } from "./mandateStore.js";
import { negotiationMandate } from "./mandate.js";
import { twilioRouter, MEDIA_PATH } from "./twilio/routes.js";
import { handleTwilioStream } from "./twilio/mediaStream.js";
import type { Mandate } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// Rutas de teléfono. Solo si hay credenciales: sin ellas el server igual sirve
// la UI del navegador.
if (config.twilioEnabled) {
  app.use(twilioRouter());
} else {
  console.warn(
    "[twilio] deshabilitado (faltan variables en .env). Solo modo navegador."
  );
}

// Endpoint para inspeccionar el estado/log de una llamada (útil para depurar).
app.get("/calls/:id", (req, res) => {
  const call = getCall(req.params.id);
  if (!call) return res.status(404).json({ error: "not_found" });
  res.json(call);
});

// El mandato capturado del cliente (persistido en data/mandate.json).
app.get("/mandate", (_req, res) => {
  res.json(getMandate());
});

const server = http.createServer(app);

// --- WebSockets --------------------------------------------------------------
const browserWss = new WebSocketServer({ noServer: true });
const twilioWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url || "/", `http://${req.headers.host}`);

  if (pathname === "/ws") {
    browserWss.handleUpgrade(req, socket, head, (ws) =>
      browserWss.emit("connection", ws, req)
    );
  } else if (pathname === MEDIA_PATH) {
    twilioWss.handleUpgrade(req, socket, head, (ws) =>
      twilioWss.emit("connection", ws, req)
    );
  } else {
    socket.destroy();
  }
});

twilioWss.on("connection", (ws) => handleTwilioStream(ws));

// --- Navegador: el transporte de respaldo ------------------------------------
browserWss.on("connection", (browserWs) => {
  let bridge: RealtimeBridge | null = null;
  let callId = "";

  const toBrowser = (obj: unknown) => {
    if (browserWs.readyState === browserWs.OPEN) browserWs.send(JSON.stringify(obj));
  };

  browserWs.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      // El navegador pide arrancar la "llamada".
      //   mode "intake" (default): Volta habla con el cliente, sin mandato previo.
      //   mode "negotiate": Volta negocia usando el mandato capturado (o el default).
      case "start": {
        const mode = msg.mode === "negotiate" ? "negotiate" : "intake";
        const mandate: Mandate | null =
          mode === "negotiate"
            ? msg.mandate || negotiationMandate(getMandate()).mandate
            : null;
        callId = createCall(mandate);

        bridge = new RealtimeBridge({
          callId,
          phase: mode,
          audioFormat: "pcm24",
          cb: {
            sendAudio: (base64) => toBrowser({ type: "audio", audio: base64 }),
            clearAudio: () => toBrowser({ type: "clear" }),
            // Acá NO sabemos cuánto se escuchó realmente: el modelo genera más
            // rápido que tiempo real, así que lo encolado supera de lejos a lo
            // reproducido y truncar con ese número sería peor que no truncar.
            // Devolviendo 0 el bridge no trunca y el navegador se comporta como
            // siempre. Para que también trunque, index.html tendría que reportar
            // la posición real de su AudioContext.
            playedMs: () => 0,
            onEvent: (kind, data) => toBrowser({ type: "event", kind, data }),
          },
        });

        toBrowser({ type: "started", callId, mode, mandate });
        break;
      }

      // Fragmento de audio del micrófono (base64 PCM16 24kHz) -> OpenAI.
      case "audio":
        bridge?.appendAudio(msg.audio);
        break;

      case "stop":
        bridge?.close();
        bridge = null;
        break;
    }
  });

  browserWs.on("close", () => {
    bridge?.close();
    bridge = null;
  });
});

server.listen(config.port, () => {
  console.log(`Volta escuchando en http://localhost:${config.port}`);
  console.log(`  navegador: abrí esa URL, permití el micrófono y apretá "Start".`);
  if (config.twilioEnabled) {
    console.log(`  teléfono:  entrante -> POST ${config.twilio.publicBaseUrl}/twilio/inbound`);
    console.log(`             saliente -> POST http://localhost:${config.port}/calls/outbound {"to":"+52..."}`);
  }
});
