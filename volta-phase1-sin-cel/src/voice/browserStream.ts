// -----------------------------------------------------------------------------
// voice/browserStream.ts
// El transporte "navegador" (fallback de demo, y a la vez el socket del
// dashboard). Espejo de twilioStream.ts, pero con audio PCM16 24 kHz.
//
// Dos roles sobre el mismo WebSocket:
//   1. DASHBOARD (siempre): se suscribe al bus y recibe los eventos de negocio
//      de CUALQUIER llamada, incluidas las telefónicas en las que no participa.
//   2. LÍNEA (solo si el navegador manda "start"): el micrófono de esa máquina
//      hace de teléfono.
// -----------------------------------------------------------------------------
import type { WebSocket } from "ws";

import { subscribe } from "../bus.js";
import { startSession } from "../session.js";
import type { Mandate } from "../types.js";

export function handleDashboardSocket(browserWs: WebSocket) {
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
      // Modo micrófono: este navegador hace de línea.
      case "start": {
        const mode = msg.mode === "negotiate" ? "negotiate" : "intake";
        // Pasar de intake a negociación abre una llamada nueva: cerramos la
        // anterior para no dejar un puente con OpenAI colgado escuchando.
        session?.bridge.close();
        session = startSession({
          mode,
          transport: "browser",
          mandate: (msg.mandate as Mandate) || null,
          sendAudio: (audio) => toBrowser({ type: "audio", audio }),
          clearAudio: () => toBrowser({ type: "clear" }),
          // Sin Twilio no hay marks: damos margen para que suene el último audio.
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

      // Fragmento de audio del micrófono (base64 PCM16 24 kHz) -> OpenAI.
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
