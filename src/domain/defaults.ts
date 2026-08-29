// -----------------------------------------------------------------------------
// domain/defaults.ts
// Domain default values, kept out of the code that consumes them.
// -----------------------------------------------------------------------------
import type { Mandate } from "./types.js";

// "Open" window: if the client gave no dates we don't want checkMandate to
// reject on timing. Price is the only hard limit.
export const OPEN_WINDOW_START = "2000-01-01T00:00";
export const OPEN_WINDOW_END = "2100-01-01T00:00";

// A pickupWindowEnd year at or above this means "no real window".
export const OPEN_WINDOW_YEAR = 2100;

// Default mandate for the carrier NEGOTIATION phase (mode: "negotiate") when
// nothing has been captured yet. Not used during intake: there the mandate is
// captured by Volta while talking to the client.
export const DEFAULT_MANDATE: Mandate = {
  origin: "Port of Manzanillo",
  destination: "Warehouse in Guadalajara",
  containerNumber: "MSCU1234567",
  maxPriceMxn: 9000,
  pickupWindowStart: "2026-09-03T08:00",
  pickupWindowEnd: "2026-09-03T18:00",
  forbiddenConditions: ["prepayment", "no insurance"],
};
