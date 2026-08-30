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
//
// THE SECOND TRAP: in Docker, a request from the machine's own browser reaches
// the container from the bridge gateway (172.17.0.1), not 127.0.0.1. Demanding a
// loopback socket rejects the very case Docker exists for — the dashboard was
// answering 403 to `docker compose up`. So a private-range source is accepted
// too, and the tunnel's fingerprint stays what actually does the blocking: a
// tunnelled request always carries forwarding headers AND a public Host, and
// fails on both counts no matter where its socket came from.
//
// What this trades away: someone else on your LAN who hits the published port
// AND forges "Host: localhost" would get through, where before they could not.
// That is a far smaller surface than the public tunnel this is here to stop, but
// on an untrusted network, leave ALLOW_REMOTE_CONTROL unset and prefer a
// loopback-only port binding (127.0.0.1:3000:3000 in compose).
// -----------------------------------------------------------------------------
import type { Request, Response, NextFunction } from "express";

// Escape hatch for running the dashboard from another machine. Off by default:
// this is the difference between "our laptop" and "the internet".
const allowRemote = process.env.ALLOW_REMOTE_CONTROL === "1";

// Loopback, or an address that can only be reached from this machine or its
// local network — which is where Docker's bridge gateway lives.
function isLocalAddress(raw: string): boolean {
  const ip = raw.replace(/^::ffff:/, "").toLowerCase();
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (ip.startsWith("127.")) return true;

  // RFC1918 + link-local (IPv4)
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  const m = /^172\.(\d{1,2})\./.exec(ip);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;

  // Unique-local + link-local (IPv6)
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;

  return false;
}

export function isLocalRequest(req: Request): boolean {
  // Any forwarding header means it came through a proxy or tunnel. This is the
  // check that actually keeps the public tunnel out.
  if (
    req.headers["x-forwarded-for"] ||
    req.headers["x-forwarded-host"] ||
    req.headers["x-forwarded-proto"] ||
    req.headers["forwarded"]
  ) {
    return false;
  }
  if (req.headers["ngrok-skip-browser-warning"]) return false;

  // ...and the Host must be a loopback name, not the public domain.
  const host = (req.headers.host || "").split(":")[0].toLowerCase();
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) return false;

  // The socket must at least be unroutable from the internet. Loopback when run
  // bare; the bridge gateway when run in Docker.
  return isLocalAddress(req.ip || req.socket.remoteAddress || "");
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
