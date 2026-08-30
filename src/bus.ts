// -----------------------------------------------------------------------------
// bus.ts
// Fan-out of "business" events to every connected dashboard.
//
// With the browser there was ONE socket that was both microphone and screen.
// With the phone they split: audio goes over Twilio and the screen is something
// else (there may be 0, 1 or 5 browsers watching). Everything that used to go
// straight to the browser socket is published here instead, and every dashboard
// receives it.
// -----------------------------------------------------------------------------

export type BusEvent = {
  kind: string;
  callId: string;
  // "browser" (browser mic) | "phone" (Twilio) | "sim" (scripted carrier / round)
  transport: "browser" | "phone" | "sim";
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
      /* a broken dashboard must not take the call down */
    }
  }
}
