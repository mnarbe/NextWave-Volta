# Volta

> A voice agent that coordinates drayage by phone: it captures a shipper's mandate, negotiates with carriers, books the best compliant offer, and keeps an auditable record of every decision.

Built for the **Nauta challenge, "The Agent on the Line,"** at NextWave Hackathon 2026.

**▶ [Watch the demo](https://drive.google.com/file/d/14F6faGotnaHcWsj6_yTxmmRLM9E8KFRI/view?usp=sharing)** — a recorded run: a shipper calls in with a mandate, three carriers negotiate in parallel, and the winning offer is booked.

**[Slides](https://docs.google.com/presentation/d/1ek1wKbfcJvwV8W-CnD4cDB2ka2Z7g1HmXDKD_22hqMY/edit?usp=sharing)** — the pitch deck.

**[volta-nextwave.vercel.app](https://volta-nextwave.vercel.app/)** — one-page overview, and the fastest way to understand the project without reading code: the problem, how a call becomes a booking, the negotiation flow and system architecture as diagrams, why the mandate is enforced in code rather than in the prompt, and the stack.

This README covers running it; [ARCHITECTURE.md](ARCHITECTURE.md) covers how the services connect.

## The problem

Much of ground transportation is still coordinated by phone. Quotes, pickup windows, changes, and exceptions live inside fast-moving conversations, leaving teams to reconcile promises from memory, notes, and follow-up calls.

Volta works that phone workflow without exceeding the authority a shipper gives it. It can collect a transport brief, negotiate several carrier quotes, select an eligible offer, and respond when an already-booked carrier changes the deal. When a request falls outside the mandate, it stops and escalates instead of improvising.

## What Volta does

1. A shipper calls Volta and provides a transport mandate: route, pickup window, price cap, and any unacceptable conditions.
2. Volta verifies the caller before recording the mandate.
3. Once intake ends, it opens a negotiation round across carriers. Scripted carriers can run in parallel, while a human carrier can join by phone or from the browser.
4. It ranks completed offers deterministically and confirms only the best offer that meets the mandate.
5. When a deal closes, it emails a written recap to both sides. A commitment counts only once that recap is out, and the booking is final only after both parties click their confirmation link.
6. If a carrier later changes the price, timing, or conditions, Volta checks the change against the same mandate. It accepts compliant changes and asks the shipper for approval when it lacks authority.
7. The dashboard shows the mandate, call activity, quotes, decisions, and handover context in real time.

## Demo flow

The intended live demo follows a container arriving in Manzanillo that needs drayage to Guadalajara.

1. Call Volta as the shipper and set a maximum price and pickup window.
2. End the intake call. Volta launches a carrier round automatically.
3. Join the human-carrier negotiation by phone or in Browser mode while the simulated carriers negotiate in parallel.
4. Watch Volta compare all finished offers and book the lowest compliant one.
5. Call back as the carrier with a delayed pickup or a higher price. Volta either resolves the change within the mandate or calls the shipper for a decision.

The flow is designed for unrehearsed inputs: authority checks and carrier selection are enforced in code, not delegated to the language model.

## Architecture

```text
                          public tunnel
   shipper / carrier  -------------------->  Twilio
                                                |
                                          Media Streams
                                                |
                                                v
   dashboard  <-- WebSocket events --  Node.js / Express  -->  OpenAI Realtime
        |                               |      |                 (live voice)
        +-- browser mic fallback -------+      |
                                               +-->  OpenAI Chat Completions
                                               |       (simulated carriers)
                     +-------------------------+---------------------+
                     v                                               v
         local JSON / Firestore                                    Resend
      mandates - quotes - decisions                                   |
             commitments                          recap to both sides, each
                     ^                            carrying a signed link
                     |                                                |
                     +--- GET /confirm/:id/:party  <------------------+
                          (records one side; both make it final)
```

Twilio Media Streams and OpenAI Realtime both support G.711 mu-law audio, so phone audio crosses the bridge without transcoding. The browser is a dashboard in phone mode and a microphone fallback when a live line is unavailable.

The email leg is a loop rather than a send-and-forget. Closing a deal sends the recap, which is what makes the commitment count; each side's link comes back in through `/confirm` and only both together make the booking final.

### Main components

| Component            | Responsibility                                                                   |
| -------------------- | -------------------------------------------------------------------------------- |
| `src/agent/`       | Realtime voice session, prompts, tool definitions, and handover summaries.       |
| `src/domain/`      | Mandate validation, commitment types, and deterministic carrier comparison.      |
| `src/negotiation/` | Carrier roster, parallel rounds, simulated carriers, and escalation logic.       |
| `src/telephony/`   | Twilio calls, Media Stream bridge, call routing, and follow-up calls.            |
| `src/email/`       | Recap emails through Resend, and the signed links that confirm a booking.        |
| `src/store/`       | Local persistence for mandates and negotiations, with optional Firestore export. |
| `public/`          | Live dashboard and browser-microphone fallback.                                  |

## Safety and authority model

Volta has a narrow mandate by design.

- The shipper's maximum price, pickup window, and forbidden conditions are validated by code before a carrier can win.
- Offers outside the mandate are not silently accepted. They are rejected or sent for shipper approval.
- Intake can require a shared caller PIN. Attempts are rate-limited and PIN digits are masked in logs.
- A commitment is not a transcript line. It clears two separate bars: it *counts* once the written recap has actually been sent, and is *final* only once both sides confirm. The state is derived from the data, never stored, so the two rules cannot drift apart. If the recap fails to send, Volta is told and must not claim it went out.
- Twilio webhooks validate `X-Twilio-Signature` by default.
- Endpoints that can place calls or reconfigure Twilio are local-only unless explicitly enabled. "Local" means no forwarding headers and a loopback `Host`, which is what keeps the public tunnel out; the source address may be a private one so the dashboard still works from a container.
- A request for a person, a complaint, a dispute, or an unclear conversation produces a handover summary with the transcript, current mandate, booking, and carrier context.

The current prototype prepares the handover context but does not yet warm-transfer the active call to a human. That final telephony step is a planned extension, not a capability claimed by the demo.

## Carrier intelligence

The dashboard includes a read-only carrier-intelligence panel. It calculates price, negotiation, and post-booking stability signals from a versioned demo history and always shows its sample size.

This information does not affect offer ranking, negotiation behavior, mandate checks, or carrier calls. After the winning carrier has been confirmed, a human can explicitly trigger a separate client-summary call from the dashboard. Volta states the selected offer and the calculated profile as additional context; the profile did not influence the selection. Future versions can append observed interactions using the same record format and use those profiles to adapt a strategy for a specific carrier.

The client-facing booking-confirmation email also includes the selected carrier's profile before its confirmation link. The carrier's own confirmation email does not include this context.

## Tech stack

- TypeScript and Node.js
- Express and WebSockets
- OpenAI Realtime API for live voice conversations
- OpenAI Chat Completions for simulated carrier negotiations
- Twilio Voice and Media Streams for phone calls
- Resend for recap and booking-confirmation emails
- Firebase Admin / Firestore for optional exports
- Vanilla HTML, CSS, and JavaScript dashboard

## Run with Docker

The fastest way to get Volta up without installing anything.

```bash
cp .env.example .env     # put your OPENAI_API_KEY in it
docker compose up --build
```

Dashboard on http://localhost:3000.

**`OPENAI_API_KEY` is the only variable you need.** Everything else degrades
gracefully — on boot the server tells you what is disabled and why.

What works with just that key:

- The dashboard.
- The **parallel carrier round**: the two scripted carriers negotiate against the
  mandate and the comparator picks a winner.
- The **human carrier over the browser microphone** (the default seat).
- The mandate enforced in code — try to push Volta over the cap and watch it refuse.

What needs more:

| Feature | Needs |
|---|---|
| Real phone calls | Twilio credentials **and** a public tunnel Twilio can reach. Docker does not replace ngrok: a container on your laptop is not reachable from Twilio. |
| Recap emails | `RESEND_API_KEY` + `RESEND_FROM` on a verified domain. Without them a commitment stays `pending_recap` and says why — that is correct behaviour, not a bug. |
| Firestore mirror | `FIREBASE_SERVICE_ACCOUNT`. Local `data/*.json` stays the source of truth either way. |

Notes:

- `data/` is mounted as a volume, so the captured mandate and negotiations
  survive `docker compose down`. The stores read it at boot, so edit it with the
  container stopped.
- `.env` is excluded from the image by `.dockerignore` — secrets are passed at
  run time, never baked in.
- **The `.env` parser is stricter than dotenv's.** Every non-comment line must be
  `KEY=value`; a bare value on its own line fails the container with
  `invalid environment variable`.

## Run locally

### Prerequisites

- Node.js 22+ (see `engines` in package.json; the Docker image pins this)
- An OpenAI API key with access to `gpt-realtime`
- For live phone calls: a Twilio account, a voice-enabled number, and a public HTTPS tunnel such as ngrok

### Setup

```bash
npm install
cp .env.example .env
```

Set at least the following values in `.env`:

```ini
OPENAI_API_KEY=sk-...
OPENAI_REALTIME_MODEL=gpt-realtime
OPENAI_TEXT_MODEL=gpt-4o-mini
```

For recap emails, also configure (the sender must be on a domain you verified in Resend):

```ini
RESEND_API_KEY=re_...
RESEND_FROM=Volta <volta@yourdomain.com>
RECAP_EMAIL=you@yourdomain.com
CONFIRM_SECRET=any-stable-string
```

Set `CONFIRM_SECRET`. Without it a new one is generated on every boot, and links from an email sent before a restart stop working.

For phone mode, also configure:

```ini
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_NUMBER=+1...
PUBLIC_URL=https://your-tunnel.ngrok-free.dev
```

Start the app:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Browser mode works without Twilio credentials, although the app still requires an OpenAI API key.

### Configure Twilio

Expose the local server first:

```bash
ngrok http 3000 --url=https://your-tunnel.ngrok-free.dev
```

Then configure the number's webhook:

```bash
npm run setup:twilio
```

The setup script detects a running ngrok tunnel when `PUBLIC_URL` is absent, validates the Twilio configuration, and points the number at Volta's voice webhook.

### Useful commands

| Command                  | Purpose                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `npm run dev`          | Start the app in watch mode.                                 |
| `npm start`            | Start the app once.                                          |
| `npm run typecheck`    | Run TypeScript checks.                                       |
| `npm run setup:twilio` | Configure the Twilio voice webhook.                          |
| `npm run test:stream`  | Exercise the Media Stream path without placing a phone call. |
| `npm run check:email`  | Send a real recap to `RECAP_EMAIL` to see how it arrives.    |
| `npm run test:email`   | Recap links, confirmation states, and the failed-send path.  |
| `npm run test:guard`   | Local-only rules: what reaches the control endpoints.        |

## Testing without a phone

Use the dashboard's **Browser mode** to speak with Volta through the machine microphone. For a deeper transport check, run:

```bash
npm run test:stream
```

This script acts like Twilio, connects to `/twilio/media`, and writes the generated greeting to `volta-greeting.wav`.

## Decision log

The log submitted for the hackathon, with timestamps, is in
[DECISION_LOG.md](DECISION_LOG.md). The table below is the standing summary of
the choices that shape the code.

| Decision                                           | Why                                                                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Validate mandates in code                          | A model can misunderstand an instruction. Price, time, and condition checks must be deterministic.                      |
| Negotiate carriers in parallel                     | Carrier availability is the bottleneck in the real workflow. Parallel calls reduce time to a comparable decision.       |
| Use phone audio end to end                         | The challenge is about a legacy phone process, so the primary interaction is a real call rather than a chat simulation. |
| Preserve a browser fallback                        | A live demo should remain usable if cellular service or a public tunnel fails.                                          |
| Store structured commitments, not only transcripts | Teams need a decision record that can be audited and acted on after the call.                                           |
| Keep humans in the approval loop                   | Volta can negotiate only within an explicit mandate. Exceptional decisions remain with the shipper.                     |
| Gate a commitment on the recap being sent          | Volta tells carriers on the call that a confirmation is coming. Sending it from the same tool that records the commitment is what makes that true rather than a claim.                     |
| Sign confirmation links instead of storing tokens  | `GET /calls/:id` returns a commitment whole, so a stored token would leak with it. An HMAC of commitment and party cannot be forged and keeps nothing secret in the record.                     |
| Ship a Dockerfile rather than a deployment         | The project has no build step and one required variable, so an image is install-and-run. Deploying would have changed the public transport days before the demo without helping telephony, which needs a tunnel either way.                     |
| Widen local-only to private addresses              | In Docker the dashboard reaches the container from the bridge gateway, so a loopback-only rule answered 403 to the very case the image exists for. The tunnel is still blocked by its fingerprint: forwarding headers and a public `Host`.                     |

## API surface

| Method   | Path               | Purpose                                                |
| -------- | ------------------ | ------------------------------------------------------ |
| `POST` | `/twilio/voice`  | Twilio inbound-call webhook.                           |
| `POST` | `/twilio/status` | Twilio call lifecycle webhook.                         |
| `WSS`  | `/twilio/media`  | Bidirectional Twilio and OpenAI audio bridge.          |
| `POST` | `/call`          | Place an outbound carrier call. Local-only by default. |
| `POST` | `/round/start`   | Start a carrier round. Local-only by default.          |
| `GET`  | `/twilio/health` | Phone and tunnel readiness.                            |
| `GET`  | `/confirm/:commitmentId/:party` | Signed link from a recap email. Records one side's confirmation. |
| `GET`  | `/round`         | Current round: negotiations and the comparator's decision. |
| `GET`  | `/calls/:id`     | One call's state and event log.                        |
| `GET`  | `/mandate`       | Current transport mandate.                             |
| `GET`  | `/negotiations`  | Carrier negotiation records.                           |
| `WSS`  | `/ws`            | Dashboard and browser-mode session.                    |

## Team workflow

For ownership conventions and contribution guidelines, see [EQUIPO.md](EQUIPO.md).

## Project status

This is a hackathon prototype built to demonstrate a real-time, mandate-bound voice workflow. It is not production-ready.

Known gaps, stated plainly:

- **Calls are not recorded**, so a commitment cannot yet cite the audio timestamp of the moment it was agreed. This is the one gap that cannot be filled retroactively: audio not captured during a call is gone.
- **The live call is not warm-transferred.** A handover writes the full context to the dashboard, and Volta says a person will pick it up with that context, which is true. Putting the person on the line is the missing last hop.
- **Prompt rules are not controls.** During a quote round Volta is told not to commit, and has been observed doing it anyway. Rules that must hold are enforced in code; the rest are guidance and can be broken.
- Round outcomes vary between runs, since the carriers negotiate for real. The winner and the winning price are not scripted.

Production deployment would also need per-customer authentication, durable operational storage, observability, and consent and recording policies.
