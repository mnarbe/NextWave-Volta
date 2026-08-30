import { isLocalRequest } from "./local-only.js";

let pass = 0, fail = 0;
const check = (n: string, c: boolean) =>
  c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n}`));

const req = (headers: Record<string, string>, ip: string) =>
  ({ headers, ip, socket: { remoteAddress: ip } }) as any;

console.log("\n-- DEBE PASAR --");
check("local, sin docker", isLocalRequest(req({ host: "localhost:3000" }, "127.0.0.1")));
check("local por IP", isLocalRequest(req({ host: "127.0.0.1:3000" }, "127.0.0.1")));
check("IPv6 loopback", isLocalRequest(req({ host: "localhost:3000" }, "::1")));
check("docker bridge 172.17", isLocalRequest(req({ host: "localhost:3000" }, "172.17.0.1")));
check("docker compose 172.18", isLocalRequest(req({ host: "localhost:3000" }, "172.18.0.1")));
check("docker mapeado ::ffff:", isLocalRequest(req({ host: "localhost:3000" }, "::ffff:172.20.0.1")));

console.log("\n-- DEBE BLOQUEAR (el túnel) --");
check("host público", !isLocalRequest(req({ host: "algo.ngrok-free.dev" }, "127.0.0.1")));
check("x-forwarded-for", !isLocalRequest(req({ host: "localhost:3000", "x-forwarded-for": "1.2.3.4" }, "127.0.0.1")));
check("x-forwarded-host", !isLocalRequest(req({ host: "localhost:3000", "x-forwarded-host": "a.ngrok.dev" }, "127.0.0.1")));
check("x-forwarded-proto", !isLocalRequest(req({ host: "localhost:3000", "x-forwarded-proto": "https" }, "127.0.0.1")));
check("forwarded (RFC7239)", !isLocalRequest(req({ host: "localhost:3000", forwarded: "for=1.2.3.4" }, "127.0.0.1")));
check("cabecera de ngrok", !isLocalRequest(req({ host: "localhost:3000", "ngrok-skip-browser-warning": "1" }, "127.0.0.1")));
check("túnel a un contenedor", !isLocalRequest(req({ host: "a.ngrok-free.dev", "x-forwarded-for": "9.9.9.9" }, "172.17.0.1")));

console.log("\n-- DEBE BLOQUEAR (internet) --");
check("IP pública", !isLocalRequest(req({ host: "localhost:3000" }, "203.0.113.7")));
check("172.15 no es privada", !isLocalRequest(req({ host: "localhost:3000" }, "172.15.0.1")));
check("172.32 no es privada", !isLocalRequest(req({ host: "localhost:3000" }, "172.32.0.1")));
check("sin host", !isLocalRequest(req({}, "127.0.0.1")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
