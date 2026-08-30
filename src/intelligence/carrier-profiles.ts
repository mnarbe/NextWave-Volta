// -----------------------------------------------------------------------------
// carrier-profiles.ts
//
// Read-only carrier intelligence for the dashboard. This module deliberately
// sits outside mandate validation, the round comparator, agent prompts, and
// telephony. It reports historical facts; it never changes a negotiation.
//
// A future writer can append observed records to data/carrier-history.json.
// The same aggregation will then combine them with the demo seed history.
// -----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Source = "seeded_demo" | "observed";
type ChangeType = "price_increase" | "pickup_change" | "cancellation" | "condition_change";

export type CarrierHistoryRecord = {
  id: string;
  source: Source;
  carrierId: string;
  carrierName: string;
  occurredAt: string;
  negotiation: {
    initialPriceMxn?: number;
    finalPriceMxn?: number;
    refusals: number;
    conditionsCount: number;
    outcome: "deal" | "no_deal";
    booked: boolean;
  };
  postBookingChange?: { type: ChangeType };
};

export type CarrierProfile = {
  carrierId: string;
  carrierName: string;
  sample: {
    negotiations: number;
    bookedJobs: number;
    seededDemoJobs: number;
    observedJobs: number;
  };
  pricing: {
    medianFinalPriceMxn?: number;
    averageConcessionRate?: number;
  };
  negotiation: {
    dealRate: number;
    averageRefusals: number;
  };
  stability: {
    postBookingChanges: number;
    pickupChanges: number;
    priceIncreaseRequests: number;
    cancellations: number;
  };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const SEED_FILE = path.join(PROJECT_ROOT, "demo", "carrier-history.json");
const OBSERVED_FILE = path.join(PROJECT_ROOT, "data", "carrier-history.json");

function readRecords(file: string): CarrierHistoryRecord[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as CarrierHistoryRecord[]) : [];
  } catch {
    return [];
  }
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function average(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function profileFor(records: CarrierHistoryRecord[]): CarrierProfile {
  const first = records[0];
  const booked = records.filter((record) => record.negotiation.booked);
  const prices = booked
    .map((record) => record.negotiation.finalPriceMxn)
    .filter((price): price is number => price != null);
  const concessions = records
    .map((record) => {
      const { initialPriceMxn, finalPriceMxn } = record.negotiation;
      if (!initialPriceMxn || finalPriceMxn == null) return undefined;
      return (initialPriceMxn - finalPriceMxn) / initialPriceMxn;
    })
    .filter((rate): rate is number => rate != null);
  const changes = booked.map((record) => record.postBookingChange?.type).filter(Boolean);

  return {
    carrierId: first.carrierId,
    carrierName: first.carrierName,
    sample: {
      negotiations: records.length,
      bookedJobs: booked.length,
      seededDemoJobs: records.filter((record) => record.source === "seeded_demo").length,
      observedJobs: records.filter((record) => record.source === "observed").length,
    },
    pricing: {
      medianFinalPriceMxn: median(prices),
      averageConcessionRate: concessions.length ? average(concessions) : undefined,
    },
    negotiation: {
      dealRate: records.filter((record) => record.negotiation.outcome === "deal").length / records.length,
      averageRefusals: average(records.map((record) => record.negotiation.refusals)),
    },
    stability: {
      postBookingChanges: changes.length,
      pickupChanges: changes.filter((type) => type === "pickup_change").length,
      priceIncreaseRequests: changes.filter((type) => type === "price_increase").length,
      cancellations: changes.filter((type) => type === "cancellation").length,
    },
  };
}

/**
 * Returns dashboard-only profiles. No caller in the negotiation path imports
 * this module, so the result cannot affect carrier ranking or agent behavior.
 */
export function listCarrierProfiles(): CarrierProfile[] {
  const all = [...readRecords(SEED_FILE), ...readRecords(OBSERVED_FILE)];
  const byCarrier = new Map<string, CarrierHistoryRecord[]>();
  for (const record of all) {
    if (!record?.carrierId || !record?.carrierName || !record?.negotiation) continue;
    const entries = byCarrier.get(record.carrierId) ?? [];
    entries.push(record);
    byCarrier.set(record.carrierId, entries);
  }
  return [...byCarrier.values()]
    .map(profileFor)
    .sort((a, b) => a.carrierName.localeCompare(b.carrierName));
}

// A confirmation email knows the agreed carrier's name, not necessarily its
// roster id. Keep that presentation lookup here, outside all negotiation code.
export function findCarrierProfileByName(name: string | undefined): CarrierProfile | undefined {
  const key = String(name || "").trim().toLocaleLowerCase();
  return key
    ? listCarrierProfiles().find((profile) => profile.carrierName.toLocaleLowerCase() === key)
    : undefined;
}
