// -----------------------------------------------------------------------------
// storage/persistence.ts
// EL ÚNICO ARCHIVO DEL PROYECTO QUE TOCA EL DISCO.
//
// Todo lo que se guarda pasa por acá. Para migrar a una base de datos de verdad
// no hace falta tocar `tools.ts`, `session.ts` ni las rutas: alcanza con dar
// otra implementación de `Collection` y cambiar la fábrica que usan
// mandateStore / negotiationStore.
//
// Nota para quien migre: la interfaz es SÍNCRONA a propósito, porque hoy hay
// tres lugares que leen sin poder esperar (`resolveMandate` en session.ts, y las
// rutas GET). Un driver síncrono (better-sqlite3, por ejemplo) entra sin tocar
// nada más. Si el driver es asíncrono (Postgres, Mongo), hay que volver async
// esos tres lugares — están marcados con "SYNC-READ" en el código.
// -----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, "..", "..", "data");

// Un "cajón" con nombre donde vive un valor. Lo mínimo que necesita el resto
// del sistema; cualquier motor que sepa hacer estas dos cosas sirve.
export type Collection<T> = {
  read(): T;
  write(value: T): T;
  /** Dónde vive (archivo, tabla, lo que sea). Solo para mostrar en la UI/logs. */
  readonly location: string;
};

// Implementación actual: un JSON por colección, cacheado en memoria.
export function jsonCollection<T>(fileName: string, fallback: () => T): Collection<T> {
  const file = path.join(DATA_DIR, fileName);
  let cache: T | undefined;

  return {
    location: file,

    read(): T {
      if (cache === undefined) {
        try {
          cache = JSON.parse(fs.readFileSync(file, "utf8")) as T;
        } catch {
          cache = fallback(); // no existe todavía, o quedó corrupto
        }
      }
      return cache;
    },

    write(value: T): T {
      cache = value;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
      return value;
    },
  };
}
