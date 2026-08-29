// -----------------------------------------------------------------------------
// scripts/setup-twilio.ts
// Deja Twilio listo sin entrar a la consola:
//   1. detecta la URL pública de ngrok (si PUBLIC_URL no está en .env, la
//      escribe ahí),
//   2. valida las credenciales,
//   3. confirma que el número es de esta cuenta,
//   4. apunta el webhook de voz del número a esta máquina,
//   5. avisa si el país al que vas a llamar está bloqueado por geo-permisos.
//
//   npm run setup:twilio            -> configura
//   npm run setup:twilio -- +5215512345678   -> además chequea ese destino
// -----------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", ".env");

// --- 1. URL pública ---------------------------------------------------------

// ngrok expone su estado en 127.0.0.1:4040. Si hay un túnel corriendo contra
// nuestro puerto, esa es la URL pública y no hace falta que nadie la copie.
async function detectNgrokUrl(): Promise<string | null> {
  for (const port of [4040, 4041]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/tunnels`, {
        signal: AbortSignal.timeout(1500),
      });
      const body: any = await res.json();
      const https = (body.tunnels || []).find((t: any) => t.public_url?.startsWith("https"));
      if (https) return https.public_url.replace(/\/+$/, "");
    } catch {
      /* probamos el siguiente puerto */
    }
  }
  return null;
}

function upsertEnv(key: string, value: string) {
  let text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, "")}\n${line}\n`;
  fs.writeFileSync(ENV_PATH, text);
}

async function main() {
  const target = process.argv[2];

  let publicUrl = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (!publicUrl) {
    const detected = await detectNgrokUrl();
    if (!detected) {
      console.error(
        "No hay PUBLIC_URL en .env y no encontré ningún túnel de ngrok corriendo.\n" +
          "Arrancá el túnel (ngrok http 3000) o poné PUBLIC_URL a mano."
      );
      process.exit(1);
    }
    publicUrl = detected;
    upsertEnv("PUBLIC_URL", publicUrl);
    console.log(`PUBLIC_URL detectada de ngrok y guardada en .env: ${publicUrl}`);
  }
  process.env.PUBLIC_URL = publicUrl;

  // Importamos DESPUÉS de fijar PUBLIC_URL: config.ts la lee al cargarse.
  const { config, twilioReady, twilioMissing } = await import("../src/config.js");
  if (!twilioReady()) {
    console.error(`Falta en .env: ${twilioMissing().join(", ")}`);
    process.exit(1);
  }
  const { twilioClient, configureNumber, geoPermission, guessIso } = await import(
    "../src/voice/twilio.js"
  );

  // --- 2. credenciales ------------------------------------------------------
  const account = await twilioClient().api.accounts(config.twilio.accountSid).fetch();
  console.log(`Cuenta: ${account.friendlyName} (${account.type}, ${account.status})`);

  // --- 3 y 4. el número apunta acá -----------------------------------------
  const number = await configureNumber();
  console.log(`Número ${number.phoneNumber} -> ${number.voiceUrl}`);
  console.log(`Media stream: ${config.publicWsUrl}/twilio/media`);

  // --- 5. geo-permisos del destino -----------------------------------------
  if (target) {
    const iso = guessIso(target);
    const geo = await geoPermission(iso);
    const ok = geo.lowRiskNumbersEnabled;
    console.log(
      `Llamadas a ${geo.country} (${iso}): ${ok ? "habilitadas" : "BLOQUEADAS"}`
    );
    if (!ok) {
      console.log(
        "  Habilitalas en Console > Voice > Settings > Geographic Permissions,\n" +
          "  o probá el demo con un número de un país ya habilitado."
      );
    }
  }

  console.log("\nListo. Arrancá el server con `npm run dev` y llamá al número.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
