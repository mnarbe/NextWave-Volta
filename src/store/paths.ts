// -----------------------------------------------------------------------------
// store/paths.ts
// The single place that knows WHERE persisted state lives on disk (data/*.json),
// so no store has to recompute paths.
// -----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// src/store/ -> project root -> data/
export const DATA_DIR = path.join(__dirname, "..", "..", "data");

export const MANDATE_FILE = path.join(DATA_DIR, "mandate.json");
export const NEGOTIATIONS_FILE = path.join(DATA_DIR, "negotiations.json");

// Read and parse a JSON file; null if missing or corrupt.
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// Write a JSON file, creating data/ if needed.
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}
