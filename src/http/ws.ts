// -----------------------------------------------------------------------------
// http/ws.ts
// WebSocket /ws: the browser sends microphone audio through here; we bridge it
// to OpenAI Realtime and send back the audio plus the events.
//
// The browser replaces the phone: mic -> /ws -> OpenAI -> /ws -> speakers.
// -----------------------------------------------------------------------------
import { WebSocketServer } from "ws";
import type http from "node:http";

import { RealtimeBridge } from "../agent/realtime.js";
import { createCall } from "../store/calls.js";
import { getMandate } from "../store/mandates.js";
import { beginNegotiation } from "../store/negotiations.js";
import { toMandate } from "../domain/mandate.js";
import { DEFAULT_MANDATE } from "../domain/defaults.js";
import type { Mandate } from "../domain/types.js";

export function attachWebSocket(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (browserWs) => {
    let bridge: RealtimeBridge | null = null;
    let callId = "";

    // Helper: send a JSON message to the browser.
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
        // The browser asks to start the "call".
        //   mode "intake" (default): Volta talks to the client, no prior mandate.
        //   mode "negotiate": Volta negotiates with a carrier using a mandate.
        case "start": {
          const mode = msg.mode === "negotiate" ? "negotiate" : "intake";
          let mandate: Mandate | null = null;
          if (mode === "negotiate") {
            const captured = getMandate();
            mandate = msg.mandate
              ? msg.mandate
              : captured
                ? toMandate(captured)
                : DEFAULT_MANDATE;
          }
          callId = createCall(mandate);

          // Open the negotiation record for this carrier (Volta fills the name
          // in via log_carrier_offer once it knows it).
          if (mode === "negotiate") beginNegotiation(callId, mandate);

          bridge = new RealtimeBridge(
            callId,
            {
              // Volta's audio -> browser.
              sendAudio: (base64) => toBrowser({ type: "audio", audio: base64 }),
              // Barge-in -> the browser flushes its playback queue.
              clearAudio: () => toBrowser({ type: "clear" }),
              // "Business" events -> UI panel.
              onEvent: (kind, data) => toBrowser({ type: "event", kind, data }),
            },
            mode
          );

          toBrowser({ type: "started", callId, mode, mandate });
          break;
        }

        // Microphone audio chunk (base64 PCM16 24kHz) -> OpenAI.
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

  return wss;
}
