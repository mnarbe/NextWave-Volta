# Volta-Negotiator — voice agent on a real phone line (Twilio + OpenAI Realtime)

Volta answers and places **real phone calls** on **+1 585 601 1456**. It talks to
the client in English, pins down the **maximum price in MXN**, and then **calls
carriers** to negotiate against that cap. Everything that happens on the call
shows up live on the web dashboard.

The browser is no longer the line: it is the screen. (Microphone mode is still
there as a fallback in case the phone fails during the demo.)

> **Working as a team?** Read [EQUIPO.md](EQUIPO.md): who owns which folder, the
> contracts between areas, and why the phone points at one machine at a time.

---

## How it fits together

```
        inbound call                              outbound call
   client ──> +1 585 601 1456              Volta ──> carrier
                    │                                    │
              POST /twilio/voice                  POST /call  (REST API)
                    │  returns TwiML                      │
                    ▼                                     ▼
            <Connect><Stream url="wss://…/twilio/media"/>
                             │
                             ▼  bidirectional WebSocket, G.711 mu-law 8 kHz
                   ┌──────────────────┐
                   │  /twilio/media   │  audio passthrough, no transcoding
                   └────────┬─────────┘
                            ▼
                 OpenAI Realtime (gpt-realtime)
                   audio.format = "audio/pcmu"
                            │
                     tools + transcripts
                            ▼
                   bus ──> dashboard (/ws)
```

The trick that keeps this simple: the Realtime GA API speaks **G.711 mu-law
8 kHz** (`audio/pcmu`) natively, which is exactly Twilio Media Streams' codec.
Audio travels base64 in both directions with no resampling and no conversion.

Each folder has one owner (see [EQUIPO.md](EQUIPO.md)):

| Path | Role | Owner |
| --- | --- | --- |
| `src/index.ts` | Entry point: HTTP server + the two WebSockets. | everyone |
| `src/config.ts` | Env config (OpenAI + Twilio). | everyone |
| `src/session.ts` · `src/bus.ts` | Start a call; fan events out to dashboards. | everyone |
| `src/http/routes.ts` | Express app + read endpoints. | everyone |
| `src/http/telephony.ts` | Twilio webhooks + control API. | call |
| `src/http/ws.ts` | WS routing, dashboard socket, browser transport. | call |
| `src/telephony/stream.ts` | Phone transport: `/twilio/media` ↔ OpenAI. | call |
| `src/telephony/twilio.ts` | TwiML, outbound calls, number config, geo permissions. | call |
| `src/telephony/routing.ts` | Who is on the other end of an inbound call (provider vs carrier). | call |
| `src/telephony/handoff.ts` | What happens after a call ends — today: ring the provider back as the carrier. | call |
| `src/agent/realtime.ts` | Bridge to OpenAI. Picks the codec per transport. | call |
| `src/agent/prompts.ts` · `src/agent/tools.ts` | What Volta knows and can do. | call |
| `src/domain/` | Types, mandate validation, defaults. | data |
| `src/store/` | Mandate, negotiations, call log. `paths.ts` is the only file that touches disk. | data |
| `public/index.html` · `public/styles.css` | Dashboard structure and looks. | design |
| `public/js/render.js` | Everything that draws. | design |
| `public/js/client.js` · `public/js/audio.js` | WebSocket, phone controls, microphone. | call |
| `scripts/setup-twilio.ts` | Configures Twilio without opening the console. | call |
| `scripts/fake-twilio.mjs` | Impersonates Twilio to test without spending calls. | call |

---

## The three numbers

| Number | What it is | Who calls it |
| --- | --- | --- |
| **+1 585 601 1456** | Volta's PROVIDER line | the client, to hand over a job |
| **+1 405 583 7265** | Volta's CARRIER line | a carrier, to reach Volta |
| **+54 9 3454 019058** | the human carrier's phone | Volta dials this one |

The role of an inbound call is decided by the number that was dialled, so there
is no guessing — see `src/telephony/routing.ts`. The human carrier is also
recognised by caller ID (`src/negotiation/roster.ts`): when they ring in, Volta
greets them by name and already knows what they quoted, so they can push a delay
or change their price without repeating the job.

## A round: three carriers at once

`POST /round/start` negotiates the current mandate against every carrier on the
roster at the same time:

- the two scripted carriers negotiate immediately, as text LLM conversations
  (`src/negotiation/`);
- the human carrier gets a seat that the next real call takes.

On these calls Volta is SHOPPING, not booking: it pushes for the best price and
tells each carrier it will call back if it goes ahead. Once everyone has quoted,
`src/domain/compare.ts` picks the winner and `src/telephony/winner-call.ts` rings
that carrier back with a short confirmation script — the only call where Volta
actually commits.

Whether a quote counts is decided in code, not by the model: a price at or below
the cap is usable, even when the model would have called it a "no deal". Leaving
that to the prompt silently dropped good carriers from the comparison.

---

## Setup

**Requirements:** Node 20+, an OpenAI API key with Realtime GA (`gpt-realtime`),
a paid Twilio account with a number, and a public tunnel to this port (ngrok),
because Twilio has to be able to reach your machine.

```bash
npm install
cp .env.example .env    # then fill in the keys
```

`.env`:

```ini
OPENAI_API_KEY=sk-...
TWILIO_ACCOUNT_SID=AC...          # Console > Account Info
TWILIO_AUTH_TOKEN=...             # same place
TWILIO_NUMBER=+15856011456
PUBLIC_URL=https://your-tunnel.ngrok-free.dev
```

Bring up the tunnel (a reserved domain, so the URL does not change between runs):

```bash
ngrok http 3000 --url=https://your-tunnel.ngrok-free.dev
```

And point the number at this machine — this replaces editing the webhook by hand
in the Twilio console:

```bash
npm run setup:twilio
```

The script finds the ngrok URL on its own (it reads the agent's local API and
writes it into `.env` if missing), validates the credentials, points the number's
`voiceUrl` at `/twilio/voice`, and warns you if the country you are about to call
is blocked by geo permissions. Pass a destination to have it checked:

```bash
npm run setup:twilio -- +5215512345678
```

---

## Running it

```bash
npm run dev
```

Open **http://localhost:3000** — that is the dashboard; you do not have to press
anything.

**1. Intake.** Call **+1 585 601 1456** from your phone. Volta answers as if you
were the provider and works through the brief: maximum price, origin,
destination, pickup day and time window, and the container number if you have
one. It saves what it has as it goes (`set_negotiation_mandate` reports which
required fields are still missing), reads the brief back for confirmation, and
**hangs up itself**. The mandate lands in `data/mandate.json` and in big type on
the dashboard.

**2. Negotiation — automatic.** Three seconds after that call ends, **Volta rings
you back on the same number**, this time to negotiate: you play the carrier. One
phone covers both roles, so the whole loop demos off a single line. Volta
negotiates against the cap, records every offer/condition/delay, and closes.

If you miss the callback and dial in instead, Volta still knows you are the
carrier and picks up the negotiation rather than starting a fresh intake.

To negotiate with a *different* carrier, type their number in the top bar and hit
**Call the carrier**. Each carrier becomes a card under "Carrier negotiation".

Volta hangs up on its own when it is done: before cutting it sends a `mark` to
Twilio and waits for it to come back, so the last sentence is never chopped.

### Without the phone (demo fallback)

The **🎙 Browser mode** button does what the old version did: this machine's
microphone is the line. Useful if there is no signal on stage or the tunnel
drops. Use headphones.

### Testing without spending calls

```bash
npm run test:stream
```

It impersonates Twilio against `/twilio/media` and saves what Volta says to
`volta-greeting.wav`. If that plays, the audio path is healthy. Pass a URL to
test through the tunnel instead of locally:

```bash
npm run test:stream -- wss://your-tunnel.ngrok-free.dev/twilio/media?mode=intake
```

---

## Endpoints

| Method | Path | What it does |
| ------ | --------------------- | ----------------------------------------------------- |
| POST | `/twilio/voice` | Inbound-call webhook → TwiML with the `<Stream>` |
| POST | `/twilio/status` | Call lifecycle (logged) |
| WSS | `/twilio/media` | mu-law audio ↔ OpenAI |
| POST | `/call` | Volta dials: `{"to":"+52...","carrier":"..."}` |
| POST | `/call/:sid/hangup` | Hang up a call in flight |
| GET | `/twilio/health` | Whether the phone is ready, plus the tunnel state |
| POST | `/twilio/setup` | Point the number at this machine |
| GET | `/twilio/geo?to=+52…` | Whether Twilio lets you call that country |
| GET | `/mandate` | The captured mandate |
| GET | `/negotiations` | Carrier negotiations |
| GET | `/calls/:id` | Full state + log of a call |
| WSS | `/ws` | Dashboard (and microphone mode) |

Webhooks verify the `X-Twilio-Signature`. To poke them with `curl`, set
`TWILIO_VALIDATE_SIGNATURE=0`.

---

## Common problems

| Symptom | Cause / fix |
| --- | --- |
| "We're sorry, an application error has occurred" | Twilio could not reach the webhook (error 11200). Almost always **ngrok died**: the dashboard bar says so ("tunnel down"). Bring it back with the reserved domain: `ngrok http 3000 --url=https://YOUR-DOMAIN.ngrok-free.dev`. If the domain changed, run `npm run setup:twilio` to re-point the number. |
| Error 21215 calling a carrier | Country blocked under Voice → Geographic Permissions. Check with `GET /twilio/geo?to=+52…`. Mexico is off by default. |
| `invalid signature` in the log | `PUBLIC_URL` does not match the real webhook URL. |
| Volta talks over the carrier | Raise `threshold` in `turnDetection()` in `src/agent/realtime.ts`. |
| It cuts you off on a short pause | Raise `silence_duration_ms` in the same place. |
| The last sentence gets chopped | The `mark` never came back: check the `/twilio/media` log. |
| `beta_api_shape_disabled` | Your account does not have Realtime GA. Use `gpt-realtime`. |
