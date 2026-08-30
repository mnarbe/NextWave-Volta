// -----------------------------------------------------------------------------
// http/local-only.ts
// Keeps the dangerous endpoints off the public tunnel.
//
// The webhooks have to be reachable from the internet and are signed, so they
// are fine. The CONTROL endpoints are a different matter: POST /call makes Volta
// dial any number in the world on our Twilio account, /round/start burns OpenAI
// credit, /twilio/setup repoints our numbers. Anyone who learns the tunnel URL
// could drive all three.
//
// THE TRAP: ngrok forwards to http://localhost:3000, so every tunnelled request
// arrives at Express from 127.0.0.1. Checking req.ip would pass the whole
// internet. What actually distinguishes them is the tunnel's own fingerprint:
// it rewrites Host to the public domain and adds X-Forwarded-*. A request is
// local only if it has neither.
// -----------------------------------------------------------------------------
import type { Request, Response, NextFunction } from "express";

// Escape hatch for running the dashboard from another machine. Off by default:
// this is the difference between "our laptop" and "the internet".
const allowRemote = process.env.ALLOW_REMOTE_CONTROL === "1";

export function isLocalRequest(req: Request): boolean {
  // Any forwarding header means it came through a proxy or tunnel.
  if (req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"]) return false;
  if (req.headers["ngrok-skip-browser-warning"]) return false;

  // ...and the Host must be a loopback name, not the public domain.
  const host = (req.headers.host || "").split(":")[0].toLowerCase();
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) return false;

  // Belt and braces: the socket itself should be loopback too.
  const ip = (req.ip || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1";
}

export function localOnly(req: Request, res: Response, next: NextFunction) {
  if (allowRemote || isLocalRequest(req)) return next();
  console.warn(
    `[security] blocked ${req.method} ${req.originalUrl} from outside ` +
      `(host=${req.headers.host}, fwd=${req.headers["x-forwarded-for"] ?? "-"})`
  );
  res.status(403).json({
    error: "local_only",
    detail:
      "This endpoint controls real phone calls and is only reachable from the " +
      "machine running Volta. Set ALLOW_REMOTE_CONTROL=1 to open it.",
  });
}
