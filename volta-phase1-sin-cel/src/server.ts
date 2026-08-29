// -----------------------------------------------------------------------------
// server.ts
// CABLEADO Y NADA MÁS. Este archivo es de todos, así que la idea es que casi
// nunca haya que tocarlo: las rutas viven en routes/ y los transportes de audio
// en voice/. Si estás por agregar lógica acá, probablemente vaya en otro lado.
//
//   TELÉFONO (Twilio)      POST /twilio/voice  -> TwiML <Connect><Stream>
//                          WSS  /twilio/media  -> audio μ-law <-> OpenAI
//                          POST /call          -> Volta llama al carrier
//
//   NAVEGADOR              WSS  /ws            -> dashboard (+ micrófono de fallback)
// -----------------------------------------------------------------------------
import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config, twilioReady, twilioMissing } from "./config.js";
import { dataRoutes } from "./routes/data.js";
import { telephonyRoutes } from "./routes/telephony.js";
import { handleTwilioMedia } from "./voice/twilioStream.js";
import { handleDashboardSocket } from "./voice/browserStream.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
// Los webhooks de Twilio llegan como form-urlencoded.
app.use(express.urlencoded({ extended: false }));
// El dashboard se sirve estático desde public/.
app.use(express.static(path.join(__dirname, "..", "public")));

app.use(dataRoutes);
app.use(telephonyRoutes);

const server = http.createServer(app);

// noServer en los dos: routeamos a mano por path (si les pasáramos `server` a
// ambos, cada uno mataría los upgrades del otro).
const twilioWss = new WebSocketServer({ noServer: true });
const dashWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url || "/", `http://${req.headers.host}`);
  if (pathname === "/twilio/media") {
    twilioWss.handleUpgrade(req, socket, head, (ws) =>
      twilioWss.emit("connection", ws, req)
    );
  } else if (pathname === "/ws") {
    dashWss.handleUpgrade(req, socket, head, (ws) =>
      dashWss.emit("connection", ws, req)
    );
  } else {
    socket.destroy();
  }
});

twilioWss.on("connection", (ws, req) => handleTwilioMedia(ws, req));
dashWss.on("connection", (ws) => handleDashboardSocket(ws));

server.listen(config.port, () => {
  console.log(`Volta escuchando en http://localhost:${config.port}`);
  if (twilioReady()) {
    console.log(`Teléfono: ${config.twilio.number}`);
    console.log(`  webhook de voz  -> ${config.publicUrl}/twilio/voice`);
    console.log(`  media stream    -> ${config.publicWsUrl}/twilio/media`);
    console.log(`  (POST /twilio/setup deja el número apuntando acá)`);
  } else {
    console.log(`Teléfono deshabilitado. Falta en .env: ${twilioMissing().join(", ")}`);
    console.log(`Podés seguir probando por navegador desde la página.`);
  }
});
