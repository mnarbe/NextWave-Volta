// -----------------------------------------------------------------------------
// scripts/check-email.ts   ->   npm run check:email
// Manda un recap real a RECAP_EMAIL para que veas cómo llega antes de la demo,
// con links de confirmación que funcionan de verdad.
// -----------------------------------------------------------------------------
import "dotenv/config";
import { sendRecap } from "../src/email/recap.js";
import { emailReady } from "../src/email/resend.js";
import type { Commitment, Mandate } from "../src/domain/types.js";

if (!emailReady()) {
  console.error("❌ Faltan RESEND_API_KEY y/o RESEND_FROM en el .env");
  process.exit(1);
}

const mandate: Mandate = {
  origin: "Port of Manzanillo",
  destination: "Warehouse in Guadalajara",
  containerNumber: "MSCU1234567",
  maxPriceMxn: 9000,
  pickupWindowStart: "2026-09-03T08:00",
  pickupWindowEnd: "2026-09-03T18:00",
  forbiddenConditions: ["prepayment"],
};

const commitment: Commitment = {
  id: `preview-${Date.now()}`,
  callId: "preview",
  priceMxn: 7400,
  pickupTime: "2026-09-03T10:00",
  conditions: [],
  agreedByName: "Juan (Fletes del Norte)",
  createdAt: new Date().toISOString(),
  confirmations: [],
};

const res = await sendRecap(commitment, mandate);
if (res.status === "sent") {
  console.log(`✅ Mandados ${res.messageIds.length} mails a: ${res.to.join(", ")}`);
  console.log(`   ids: ${res.messageIds.join(", ")}`);
  console.log(`\n   Los links apuntan a ${process.env.PUBLIC_URL || "localhost"} —`);
  console.log(`   para que funcionen, el server tiene que estar corriendo.`);
} else {
  console.error(`❌ No salió: ${res.error}`);
  process.exit(1);
}
