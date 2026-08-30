// -----------------------------------------------------------------------------
// index.ts
// Entry point. Boots the HTTP server (dashboard + endpoints) and attaches the
// two WebSockets: /twilio/media for phone calls and /ws for the dashboard.
// -----------------------------------------------------------------------------
import http from "node:http";

import { config, twilioReady, twilioMissing } from "./config.js";
import { createApp } from "./http/routes.js";
import { attachWebSocket } from "./http/ws.js";
import { watchLine } from "./telephony/line.js";
import { watchRounds } from "./telephony/winner-call.js";

const server = http.createServer(createApp());
attachWebSocket(server);
// When a round closes, call the winning carrier back to confirm.
// Track whether a phone call is up, so follow-up calls wait for a free line.
watchLine();
watchRounds();

server.listen(config.port, () => {
  console.log(`Volta listening on http://localhost:${config.port}`);
  if (twilioReady()) {
    console.log(`Phone: ${config.twilio.number}`);
    console.log(`  voice webhook -> ${config.publicUrl}/twilio/voice`);
    console.log(`  media stream  -> ${config.publicWsUrl}/twilio/media`);
    console.log(`  (POST /twilio/setup points the number here)`);
  } else {
    console.log(`Phone disabled. Missing in .env: ${twilioMissing().join(", ")}`);
    console.log(`You can still test from the browser on that URL.`);
  }
});
