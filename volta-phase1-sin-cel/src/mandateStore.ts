// -----------------------------------------------------------------------------
// mandateStore.ts
// El "lugar donde queda guardado" el mandato que Volta captura del jurado.
// Persiste en data/mandate.json para que las fases siguientes (negociación con
// los 3 proveedores) lo puedan leer aunque se reinicie el server.
// -----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NegotiationMandate } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "mandate.json");

let current: NegotiationMandate | null = load();

function load(): NegotiationMandate | null {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as NegotiationMandate;
  } catch {
    return null;
  }
}

export function getMandate(): NegotiationMandate | null {
  return current;
}

export function saveMandate(mandate: NegotiationMandate): NegotiationMandate {
  current = mandate;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(mandate, null, 2), "utf8");
  return mandate;
}

export const MANDATE_FILE = FILE;
