// -----------------------------------------------------------------------------
// index.ts
// Entry point. No Twilio: it boots the HTTP server (UI + endpoints) and attaches
// the /ws WebSocket that bridges the browser to OpenAI Realtime.
// -----------------------------------------------------------------------------
import http from "node:http";

import { config } from "./config.js";
import { createApp } from "./http/routes.js";
import { attachWebSocket } from "./http/ws.js";

const server = http.createServer(createApp());
attachWebSocket(server);

server.listen(config.port, () => {
  console.log(`Volta (browser mode) listening on http://localhost:${config.port}`);
  console.log(`Open that URL, allow the microphone and press "Start".`);
});
