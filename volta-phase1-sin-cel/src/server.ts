// -----------------------------------------------------------------------------
// server.ts
// Sin Twilio. Dos responsabilidades:
//   1) Servir la página de prueba (public/index.html).
//   2) WebSocket /ws: el navegador manda el audio del micrófono por acá; lo
//      puenteamos con OpenAI Realtime y devolvemos el audio + los eventos.
//
// El navegador reemplaza al teléfono: mic -> /ws -> OpenAI -> /ws -> parlantes.
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
import { beginNegotiation, getAllNegotiations } from "./negotiationStore.js";
import type { Mandate, NegotiationMandate } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
// Servimos la UI de prueba desde /public.
app.use(express.static(path.join(__dirname, "..", "public")));

// Endpoint para inspeccionar el estado/log de una llamada (útil para depurar).
app.get("/calls/:id", (req, res) => {
  const call = getCall(req.params.id);
  if (!call) return res.status(404).json({ error: "not_found" });
  res.json(call);
});

// El mandato capturado del jurado (persistido en data/mandate.json). Las fases
// siguientes (negociación con proveedores) lo leen de acá.
app.get("/mandate", (_req, res) => {
  res.json(getMandate());
});

// Estado de la negociación con carriers (para el dashboard). Un registro por
// carrier: qué ofreció, condiciones/demoras, y la decisión final.
app.get("/negotiations", (_req, res) => {
  res.json(getAllNegotiations());
});

// Mandato por defecto para la fase de NEGOCIACIÓN con transportista (mode:
// "negotiate"). En la fase de intake (default) NO se usa: el mandato lo captura
// Volta hablando con el jurado.
const DEFAULT_MANDATE: Mandate = {
  origin: "Port of Manzanillo",
  destination: "Warehouse in Guadalajara",
  containerNumber: "MSCU1234567",
  maxPriceMxn: 9000,
  pickupWindowStart: "2026-09-03T08:00",
  pickupWindowEnd: "2026-09-03T18:00",
  forbiddenConditions: ["prepayment", "no insurance"],
};

// Ventana "abierta": si el jurado no dio fechas, no queremos que checkMandate
// rechace por horario. Solo el precio es límite duro.
const OPEN_WINDOW_START = "2000-01-01T00:00";
const OPEN_WINDOW_END = "2100-01-01T00:00";

// El mandato capturado del jurado (NegotiationMandate) -> el shape que usa la
// fase de negociación (Mandate), completando lo que falte.
function toNegotiationMandate(m: NegotiationMandate): Mandate {
  return {
    origin: m.origin || "(origin not specified)",
    destination: m.destination || "(destination not specified)",
    containerNumber: m.containerNumber,
    maxPriceMxn: m.maxPriceMxn,
    pickupWindowStart: m.pickupWindowStart || OPEN_WINDOW_START,
    pickupWindowEnd: m.pickupWindowEnd || OPEN_WINDOW_END,
    forbiddenConditions: m.forbiddenConditions || [],
  };
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (browserWs) => {
  let bridge: RealtimeBridge | null = null;
  let callId = "";

  // Helper: mandar un mensaje JSON al navegador.
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
      //   mode "intake" (default): Volta habla con el jurado, sin mandato previo.
      //   mode "negotiate": Volta negocia con transportista usando un mandato.
      case "start": {
        const mode = msg.mode === "negotiate" ? "negotiate" : "intake";
        let mandate: Mandate | null = null;
        if (mode === "negotiate") {
          const captured = getMandate();
          mandate = msg.mandate
            ? msg.mandate
            : captured
              ? toNegotiationMandate(captured)
              : DEFAULT_MANDATE;
        }
        callId = createCall(mandate);

        // Abrimos el registro de negociación para este carrier (el nombre lo
        // completa Volta con log_carrier_offer cuando lo sepa).
        if (mode === "negotiate") beginNegotiation(callId, mandate);

        bridge = new RealtimeBridge(
          callId,
          {
            // Audio de Volta -> navegador.
            sendAudio: (base64) => toBrowser({ type: "audio", audio: base64 }),
            // Barge-in -> el navegador limpia su cola de reproducción.
            clearAudio: () => toBrowser({ type: "clear" }),
            // Eventos "de negocio" -> panel de la UI.
            onEvent: (kind, data) => toBrowser({ type: "event", kind, data }),
          },
          mode
        );

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
  console.log(`Volta (sin celular) escuchando en http://localhost:${config.port}`);
  console.log(`Abrí esa URL en el navegador, permití el micrófono y apretá "Start".`);
});
