// -----------------------------------------------------------------------------
// server.ts
// Junta todo. Tres responsabilidades:
//
//   1) POST /calls        -> dispara una llamada saliente real vía Twilio.
//   2) POST /twiml        -> Twilio pide esto al conectar; devolvemos TwiML que
//                            abre un Media Stream hacia nuestro WebSocket.
//   3) WS /media          -> Twilio nos envía el audio de la llamada por acá;
//                            lo puenteamos con la sesión de OpenAI Realtime.
//
// Para que Twilio alcance (2) y (3), el server debe ser público (ngrok en dev).
// -----------------------------------------------------------------------------
import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import twilio from "twilio";

import { config } from "./config.js";
import { createCall, getCall, log } from "./store.js";
import { RealtimeBridge } from "./realtime.js";
import type { Mandate } from "./types.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Twilio manda form-urlencoded

const twilioClient = twilio(config.twilioAccountSid, config.twilioAuthToken);

// -----------------------------------------------------------------------------
// 1) Disparar una llamada saliente.
//    Body esperado: { to: "+521...", mandate: { ...Mandate } }
// -----------------------------------------------------------------------------
app.post("/calls", async (req, res) => {
  const to: string = req.body.to;
  const mandate: Mandate = req.body.mandate;

  if (!to || !mandate) {
    return res.status(400).json({ error: "Faltan 'to' o 'mandate' en el body." });
  }

  // Creamos el estado de la llamada y guardamos el mandato bajo un callId propio.
  const callId = createCall(mandate);

  // La URL de TwiML que Twilio va a pedir cuando la persona atienda.
  // Le pasamos el callId por query para poder recuperar el mandato después.
  const twimlUrl = `https://${config.publicHost}/twiml?callId=${callId}`;

  try {
    const call = await twilioClient.calls.create({
      to,
      from: config.twilioFromNumber,
      url: twimlUrl, // Twilio hace GET/POST acá al conectar
    });
    log(callId, "call_started", { twilioSid: call.sid, to });
    res.json({ callId, twilioSid: call.sid });
  } catch (err) {
    log(callId, "error", { where: "twilio_create_call", err: String(err) });
    res.status(500).json({ error: String(err) });
  }
});

// -----------------------------------------------------------------------------
// 2) TwiML: le decimos a Twilio que abra un Media Stream bidireccional hacia
//    nuestro WebSocket, pasándole el callId como parámetro del stream.
// -----------------------------------------------------------------------------
app.all("/twiml", (req, res) => {
  const callId = (req.query.callId as string) || "";
  const response = new twilio.twiml.VoiceResponse();
  const connect = response.connect();
  const stream = connect.stream({
    url: `wss://${config.publicHost}/media`,
  });
  // Este parámetro llega en el evento "start" del media stream.
  stream.parameter({ name: "callId", value: callId });

  res.type("text/xml").send(response.toString());
});

// Endpoint simple para ver el estado/log de una llamada (útil en el demo).
app.get("/calls/:id", (req, res) => {
  const call = getCall(req.params.id);
  if (!call) return res.status(404).json({ error: "not_found" });
  res.json(call);
});

// -----------------------------------------------------------------------------
// 3) WebSocket de media. Twilio se conecta acá y nos manda eventos:
//    - "start": arranca el stream, trae streamSid y customParameters (callId).
//    - "media": un fragmento de audio (base64 μ-law) de la persona.
//    - "stop":  terminó la llamada.
//    Puenteamos cada llamada con su propia RealtimeBridge.
// -----------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  let bridge: RealtimeBridge | null = null;
  let callId = "";
  let streamSid = "";

  twilioWs.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "start": {
        streamSid = msg.start.streamSid;
        callId = msg.start.customParameters?.callId || "";
        const call = getCall(callId);
        if (call) call.streamSid = streamSid;

        // Creamos la sesión de OpenAI para esta llamada, con los callbacks que
        // saben cómo mandarle audio a ESTE stream de Twilio.
        bridge = new RealtimeBridge(callId, {
          sendAudio: (base64) => {
            twilioWs.send(
              JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: base64 },
              })
            );
          },
          clearAudio: () => {
            // Le decimos a Twilio que descarte lo que tenga encolado (barge-in).
            twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
          },
        });
        log(callId, "call_started", { side: "twilio_media", streamSid });
        break;
      }

      case "media":
        // Audio de la persona -> OpenAI.
        bridge?.appendAudio(msg.media.payload);
        break;

      case "stop":
        log(callId, "call_ended", { side: "twilio_media" });
        bridge?.close();
        break;
    }
  });

  twilioWs.on("close", () => {
    bridge?.close();
  });
});

server.listen(config.port, () => {
  console.log(`Volta Fase 1 escuchando en puerto ${config.port}`);
  console.log(`Host público: https://${config.publicHost}`);
  console.log(`Disparar llamada: POST https://${config.publicHost}/calls`);
});
