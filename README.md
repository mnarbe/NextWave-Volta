# Volta-Negotiator — Phase 0 (intake with the client)

Voice agent that runs **in the browser** (microphone + speakers) against the
**OpenAI Realtime API (GA)**. In this phase Volta talks in **English** with the
*client* (the person handing over the shipment), pins down the **maximum price in
MXN**, saves it and ends the call. That price is then used to negotiate with
carriers (phase 2, not built yet).

---

## Requirements

- **Node.js 20+** (tested on 24 LTS). `node -v` has to answer.
- An **OpenAI API key** with access to the Realtime API **GA** (model
  `gpt-realtime`). The beta shape no longer works.
- **Headphones** (without them the mic picks up Volta's voice and it interrupts
  itself).
- A Chromium browser (Chrome / Edge).

---

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and drop in your key:

```ini
OPENAI_API_KEY=sk-...                # required
OPENAI_REALTIME_MODEL=gpt-realtime   # optional (defaults to gpt-realtime)
PORT=3000                            # optional
```

`.env`, `node_modules/` and `data/` are in `.gitignore` — they are not committed.

---

## Running it

```bash
npm run dev      # tsx watch: reloads on edit
```

You should see:

```
Volta (browser mode) listening on http://localhost:3000
```

1. Open **http://localhost:3000**.
2. Put your headphones on and press **Start**.
3. Allow the microphone when prompted.
4. Play the client: describe the shipment and **the most you'll pay** (in pesos).
5. Once Volta has a firm number:
   - it calls `set_negotiation_mandate` → saved to **`data/mandate.json`**,
   - the right-hand **"Client brief"** panel shows the price in large type,
   - it reads the brief back, wraps up and hangs up (`end_intake`).

To stop the server: `Ctrl+C` in the terminal.

### `npm run start`

Same as `dev` but without auto-reload (`tsx src/index.ts`).

---

## What you see on screen

- **Left:** the transcribed conversation (you and Volta).
- **Right (dashboard):**
  - **Client brief:** maximum price (MXN) plus origin, destination, container,
    pickup window and forbidden conditions, as Volta pulls them out.
  - **Final decision:** how the negotiation closed (deal / no deal), with which
    carrier, at what price (vs. the cap) and at what pickup time. It includes the
    **"To relay to the client"** list: carrier delays and conditions that have to
    be passed on afterwards.
  - **Carrier negotiation:** one card per carrier with their latest price, the
    pickup delay against the requested window (`⏱ +N days` badge), the
    conditions/surcharges they attached (chips), the refusal counter and the full
    offer history.
  - **Backend activity:** every tool the model calls, its arguments and result.

If a `data/mandate.json` or `data/negotiations.json` from a previous run exists,
the panel preloads them when the page opens. A new mandate
(`set_negotiation_mandate`) clears the old negotiations.

---

## Test script (say it out loud, you are the client)

> "Hi Volta. I need to move a container from the Port of Manzanillo to a
> warehouse in Guadalajara. Container number MSCU1234567."

> "Pickup has to be on September 3rd, any time between 8 in the morning and 6 pm."

> "I won't accept prepayment, and the load has to be insured."

> "The most I can pay is 9,000 pesos. Don't go over that."

Volta should: repeat the window back in ISO to confirm, call
`set_negotiation_mandate` with `maxPriceMxn: 9000`, confirm the brief in one
sentence and close.

Also try:

- **Ambiguous price:** "somewhere between 8 and 10 thousand" → Volta takes 10,000
  as the cap and says so.
- **No price:** never mention money → Volta asks directly and saves nothing until
  it has a number.
- **Barge-in:** interrupt mid-sentence → it stops and listens.

---

## Endpoints (debug)

| Method | Route            | What it returns                                                      |
| ------ | ---------------- | -------------------------------------------------------------------- |
| GET    | `/mandate`       | the last captured mandate (or `null`)                                |
| GET    | `/negotiations`  | array of carrier negotiations (offers, conditions, decision)         |
| GET    | `/calls/:id`     | state + full log of one call                                         |

---

## Common problems

| Symptom                                | Cause / fix                                                                |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `beta_api_shape_disabled` in the panel | your account/model has no Realtime GA. Use `gpt-realtime`.                  |
| Volta interrupts itself                | wear headphones. If it persists: raise `threshold` to `0.8` in `src/agent/realtime.ts`. |
| It cuts you off mid-sentence           | raise `silence_duration_ms` to `1000` in `src/agent/realtime.ts`.           |
| It picks up too much room noise        | `noise_reduction: { type: "far_field" }` if you sit far from the mic.       |
| No sound at all                        | check microphone permissions and that the browser is not muted.             |

---

## Structure

The code is ordered by responsibility: the domain knows nothing about HTTP, the
store only persists, the agent only talks to OpenAI, and `http/` only transports.

```
src/
  index.ts              boot: HTTP + WebSocket
  config.ts             environment variables (.env)
  domain/               business rules and language (no I/O)
    types.ts            Mandate, NegotiationMandate, CarrierOffer/Negotiation, logs
    mandate.ts          checkMandate(), toMandate(), computeDelayDays()
    defaults.ts         default mandate + "open" window
  store/                state and persistence
    paths.ts            data/ paths + JSON read/write
    calls.ts            in-memory state of each call + log
    mandates.ts         data/mandate.json
    negotiations.ts     data/negotiations.json
  agent/                everything that touches OpenAI Realtime
    realtime.ts         bridge (GA, PCM16 24 kHz) + events to the UI
    prompts.ts          buildIntakeInstructions() / buildInstructions()
    tools.ts            tool definitions + runTool()
  http/                 transport
    routes.ts           Express: serves public/ and GET /mandate, /negotiations, /calls/:id
    ws.ts               WebSocket /ws: browser <-> RealtimeBridge
public/index.html       client: mic, playback, dashboard
data/                   persisted *.json (gitignored)
```

---

## What's next

- **Phase 2:** 3 simulated carriers (each with its own API key + personality: one
  expensive, one haggler, one that drops to something reasonable). Volta
  negotiates against the saved price. The negotiation flow is already parked in
  the code (`mode: "negotiate"`, `src/agent/prompts.ts` → `buildInstructions`,
  tools `check_mandate` / `propose_commitment`).
- **Phase 3:** comparator across the 3 negotiations + escalation.
