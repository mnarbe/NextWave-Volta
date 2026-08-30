// -----------------------------------------------------------------------------
// http/ws.ts
// The two WebSockets, routed by path off the same HTTP server:
//
//   /twilio/media  -> the PHONE transport (mu-law audio <-> OpenAI).
//   /ws            -> the DASHBOARD, and the browser-microphone fallback.
//
// The /ws socket has two roles at once:
//   1. DASHBOARD (always): subscribes to the bus and receives the business
//      events of ANY call, including phone calls it takes no part in.
//   2. LINE (only if the browser sends "start"): that machine's microphone
//      stands in for the phone.
// -----------------------------------------------------------------------------
import { WebSocketServer } from "ws";
import type http from "node:http";
import type { WebSocket } from "ws";

import { subscribe } from "../bus.js";
import { startSession } from "../session.js";
import { claimPendingHumanCarrier } from "../negotiation/round.js";
import { handleTwilioMedia } from "../telephony/stream.js";
import type { Mandate } from "../domain/types.js";

export function attachWebSocket(server: http.Server): void {
  // noServer on both: we route by path by hand. If we handed `server` to both,
  // each would kill the other's upgrades.
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
}

function handleDashboardSocket(browserWs: WebSocket) {
  let session: ReturnType<typeof startSession> | null = null;

  const toBrowser = (obj: unknown) => {
    if (browserWs.readyState === browserWs.OPEN) browserWs.send(JSON.stringify(obj));
  };

  const unsubscribe = subscribe((evt) =>
    toBrowser({
      type: "event",
      kind: evt.kind,
      data: evt.data,
      callId: evt.callId,
      transport: evt.transport,
    })
  );

  browserWs.on("message", (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      // Microphone mode: this browser stands in for the line.
      case "start": {
        const mode = msg.mode === "negotiate" ? "negotiate" : "intake";
        // Going from intake to negotiation opens a new call: close the previous
        // one so we do not leave a bridge to OpenAI hanging around listening.
        session?.bridge.close();
        // If a round is waiting for its human carrier, this session fills that
        // seat (reuses the pre-created callId, inherits the carrier/round tags).
        const claimed = mode === "negotiate" ? claimPendingHumanCarrier() : null;
        session = startSession({
          mode,
          transport: "browser",
          mandate: (msg.mandate as Mandate) || null,
          callId: claimed?.callId,
          carrier: claimed
            ? {
                carrierId: claimed.carrierId,
                carrierName: claimed.carrierName,
                kind: "human",
                roundId: claimed.roundId,
              }
            : undefined,
          sendAudio: (audio) => toBrowser({ type: "audio", audio }),
          clearAudio: () => toBrowser({ type: "clear" }),
          // No Twilio marks here: give the last audio time to play out.
          onFinal: () => setTimeout(() => session?.bridge.close(), 3500),
        });
        toBrowser({
          type: "started",
          callId: session.callId,
          mode,
          mandate: session.mandate,
        });
        break;
      }

      // Microphone audio chunk (base64 PCM16 24 kHz) -> OpenAI.
      case "audio":
        session?.bridge.appendAudio(msg.audio);
        break;

      case "stop":
        session?.bridge.close();
        session = null;
        break;
    }
  });

  browserWs.on("close", () => {
    unsubscribe();
    session?.bridge.close();
    session = null;
  });
}
