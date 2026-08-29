// -----------------------------------------------------------------------------
// bus.ts
// Fan-out de eventos "de negocio" hacia los dashboards conectados.
//
// Con el navegador había UN socket que era a la vez micrófono y pantalla. Con
// teléfono se separan: el audio va por Twilio y la pantalla es otra cosa (puede
// haber 0, 1 o 5 navegadores mirando). Todo lo que antes iba al socket del
// navegador ahora se publica acá y cada dashboard lo recibe.
// -----------------------------------------------------------------------------

export type BusEvent = {
  kind: string;
  callId: string;
  // "browser" (mic del navegador) | "phone" (Twilio)
  transport: "browser" | "phone";
  data: unknown;
};

type Listener = (evt: BusEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function publish(evt: BusEvent): void {
  for (const fn of listeners) {
    try {
      fn(evt);
    } catch {
      /* un dashboard roto no puede tumbar la llamada */
    }
  }
}
