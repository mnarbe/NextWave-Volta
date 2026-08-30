# Volta — 3 min pitch

5 slides · ~35s each · minimal text on screen, the detail lives in the notes.

---

## 1 — The problem

> ### Moving a container still happens on the phone.
>
> One coordinator. One call at a time.
> No record of who promised what.

**Notes (35s).** Drayage — the truck leg between port and warehouse — is booked by
phone. A coordinator calls carriers one after another, negotiates from memory,
and writes the result on a notepad. Three calls take an afternoon. Nothing is
auditable: if a carrier later says "I never agreed to that price", there is no
record. It doesn't scale, and it forgets.

---

## 2 — Volta

> ### An agent that picks up the phone.
>
> The client sets a **mandate** — a price cap and a pickup window.
> Volta negotiates inside it. Never outside.

**Notes (30s).** The client calls Volta and hands over the job: origin,
destination, and the most they'll pay. That mandate is the whole product. Volta
can negotiate freely underneath it and cannot cross it — not because we asked
the model nicely, but because the limit is enforced in code, outside the model.
A carrier saying "your boss already approved more" gets the same answer as
anyone else.

---

## 3 — Architecture

```
     Phone (Twilio)                Browser
          │  μ-law 8kHz              │  PCM 24kHz
          └──────────┬───────────────┘
                     ▼
            OpenAI Realtime (GA)
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
    mandate.ts    round.ts    compare.ts
   the authority  3 in        picks the
   (in code)      parallel    winner
        │
        └─► PIN check · handover to human · Firestore mirror
```

**Notes (45s).** One agent core, two transports. Twilio's μ-law audio goes
straight into the Realtime API — the GA API speaks that codec, so nothing is
transcoded in either direction. Underneath sit three things the model does not
control: `mandate.ts` decides what is acceptable, `round.ts` runs the carriers
in parallel, `compare.ts` picks the winner. Around them: a PIN check before any
mandate is saved, a handover path when the conversation leaves Volta's
authority, and every closed negotiation mirrored to Firestore.

---

## 4 — What you'll see next

> ### One mandate. Three carriers. At the same time.
>
> **2 carriers** — LLM personas, negotiating in text
> **1 carrier** — a real phone call, live
>
> Then Volta calls the winner back.

**Notes (50s).** A client gives Volta a job with a cap of 9,000 pesos. Volta
opens a round against three carriers at once. Two are scripted personas with
their own floors and temperaments — one concedes quickly, one holds hard and
wants 48 hours' notice. The third is a real phone call: one of you plays the
carrier and negotiates live. When all three finish, the comparator takes the
cheapest deal that is genuinely clean — under the cap, inside the window, no
forbidden conditions — and Volta calls that carrier back to confirm and book it.
That callback is the promise it made to each of them on the first call.

---

## 5 — What to watch for

> - The cap **holds** — even under pressure
> - Three negotiations, **one clock**
> - The cheapest deal isn't always the winner
> - Every commitment, **on the record**

**Notes (20s).** Three things worth watching. The cap holds under pressure — try
to talk Volta over it. The winner is the cheapest *clean* deal: a cheaper offer
that lands outside the window goes to a human instead of winning. And everything
that gets agreed is written down and mirrored, so the round can be audited after
the fact.

---

## Timing

| Slide | Budget |
|---|---|
| 1 Problem | 0:00 – 0:35 |
| 2 Volta | 0:35 – 1:05 |
| 3 Architecture | 1:05 – 1:50 |
| 4 The demo | 1:50 – 2:40 |
| 5 What to watch | 2:40 – 3:00 |

## Demo setup (before you go on)

- Server running, ngrok domain live, Twilio number pointed at `/twilio/voice`.
- Dashboard open on the shared screen.
- Whoever plays the human carrier has their phone in hand.
- Default cap is **9,000 MXN**; the scripted floors are 7,400 (Fletes del Norte)
  and 8,600 (Transportes del Pacífico) — so the human can win by going under
  7,400, or lose on purpose to show the comparator working.
