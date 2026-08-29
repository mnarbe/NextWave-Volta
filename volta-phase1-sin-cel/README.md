# Volta — negociador de drayage por teléfono

Agente de voz sobre la **OpenAI Realtime API (GA)** que habla en **inglés**: le
saca al cliente el **precio máximo en MXN**, lo guarda, y con ese mandato negocia
con transportistas. Todo compromiso queda anclado al segundo exacto del audio.

Corre sobre **dos transportes**, con el mismo backend:

| Transporte | Audio | Para qué |
|---|---|---|
| **Teléfono** (Twilio) | G.711 μ-law 8 kHz | Llamadas reales, entrantes y salientes |
| **Navegador** | PCM16 24 kHz | Fallback de demo, sin depender de la red del venue |

El mandato, las tools y el motor de reglas son los mismos en los dos casos: lo
único que cambia es de dónde viene el audio. La API GA acepta
`{ type: "audio/pcmu" }`, así que el μ-law de Twilio entra y sale **sin
transcodificar**.

> El directorio se sigue llamando `volta-phase1-sin-cel` por historia del repo;
> el "sin celular" ya no aplica.

---

## Requisitos

- **Node.js 20+** (probado con 24 LTS). `node -v` tiene que responder.
- Una **API key de OpenAI** con acceso a la Realtime API **GA** (modelo
  `gpt-realtime`). La beta ya no funciona.
- **Auriculares** (sin ellos el mic capta la voz de Volta y se auto-interrumpe).
- Un navegador Chromium (Chrome / Edge).

---

## Setup

```bash
cd volta-phase1-sin-cel
npm install
cp .env.example .env
```

Editá `.env` y poné tu key:

```ini
OPENAI_API_KEY=sk-...                # obligatorio
OPENAI_REALTIME_MODEL=gpt-realtime   # opcional (default gpt-realtime)
PORT=3000                            # opcional
MANDATE_TZ_OFFSET=-06:00             # zona del mandato (México). Ver "Zona horaria".

# Twilio: OPCIONAL. Sin estas 4 el server arranca igual, en modo navegador.
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...            # E.164
PUBLIC_BASE_URL=https://algo.ngrok-free.app   # sin barra final
```

`.env`, `node_modules/` y `data/` están en `.gitignore` — no se commitean.

---

## Correrlo

```bash
npm run dev      # tsx watch: recarga solo al editar
```

Vas a ver:

```
Volta escuchando en http://localhost:3000
```

1. Abrí **http://localhost:3000**.
2. Poné los auriculares y apretá **Start**.
3. Permití el micrófono cuando lo pida.
4. Hacé de jurado: contale el envío y **cuánto es lo máximo que pagás** (en pesos).
5. Cuando Volta tiene el número firme:
   - llama a `set_negotiation_mandate` → se guarda en **`data/mandate.json`**,
   - el panel derecho **"Mandato capturado"** muestra el precio en grande,
   - te confirma el brief, te corta sutilmente y cuelga (`end_intake`).

Para frenar el server: `Ctrl+C` en la terminal.

### `npm run start`

Igual que `dev` pero sin recarga automática (`tsx src/server.ts`).

---

## Correrlo con teléfono

**1. Validá el formato de audio primero.** Es lo único del stack telefónico que
no se puede probar sin la API key, y todo lo demás depende de que ande:

```bash
npm run check:pcmu
```

Tiene que decir `audio/pcmu ACEPTADO`. Si lo rechaza, el plan B es `audio/pcm` a
24 kHz + resampleo μ-law, y el cambio queda contenido en
`src/twilio/mediaStream.ts`.

**2. Exponé el server** y completá las 4 variables de Twilio en `.env`:

```bash
ngrok http 3000     # copiá la URL https:// a PUBLIC_BASE_URL
```

**3. En la consola de Twilio**, el webhook de voz del número apunta a
`POST $PUBLIC_BASE_URL/twilio/inbound`.

**4. Llamada entrante:** marcá el número desde tu celular. Sin mandato guardado
Volta hace el intake; con mandato guardado, negocia.

**5. Llamada saliente:**

```bash
curl -X POST localhost:3000/calls/outbound \
     -H 'Content-Type: application/json' -d '{"to":"+52..."}'
```

### Tests

```bash
npm test          # motor de mandato + zona horaria. No necesita red ni claves.
npm run test:live # TwiML, ruteo de WebSockets y un stream de Twilio simulado.
                  # Requiere el server corriendo en :3399 (ver el script).
```

---

## Qué ves en pantalla

- **Izquierda:** la conversación transcrita (vos y Volta).
- **Derecha:**
  - **Mandato capturado:** precio máximo (MXN) + origen, destino, contenedor,
    ventana de pickup y condiciones vetadas, a medida que Volta las saca.
  - **Actividad del backend:** cada tool que llama el modelo, sus argumentos y el
    resultado.

Si ya había un `data/mandate.json` de una corrida anterior, el panel lo precarga
al abrir la página.

---

## Guion para probar (decilo en inglés, sos el jurado)

> "Hi Volta. I need to move a container from the Port of Manzanillo to a
> warehouse in Guadalajara. Container number MSCU1234567."

> "Pickup has to be on September 3rd, any time between 8 in the morning and 6 pm."

> "I won't accept prepayment, and the load has to be insured."

> "The most I can pay is 9,000 pesos. Don't go over that."

Volta debería: repetir la ventana en ISO para confirmar, llamar a
`set_negotiation_mandate` con `maxPriceMxn: 9000`, confirmar el brief en una
frase y cerrar.

Probá también:
- **Precio ambiguo:** "somewhere between 8 and 10 thousand" → Volta toma 10,000
  como tope y lo dice.
- **Sin precio:** no menciones plata → Volta te lo pregunta directo y no guarda
  nada hasta tener un número.
- **Barge-in:** interrumpilo a mitad de frase → corta y te escucha.

---

## Endpoints (debug)

| Método | Ruta | Qué devuelve |
|---|---|---|
| GET | `/mandate` | el último mandato capturado (o `null`) |
| GET | `/calls/:id` | estado + log completo de una llamada (con `audioMs`) |
| POST | `/calls/outbound` | `{"to":"+52..."}` → Volta llama a ese número |
| POST | `/twilio/inbound` | webhook de voz: devuelve el TwiML del stream |
| ALL | `/twilio/outbound-twiml` | TwiML de la llamada saliente |
| POST | `/twilio/status` | ciclo de vida de la llamada |

WebSockets: `/ws` (navegador, PCM16) y `/twilio/media` (Twilio, μ-law).

---

## Problemas comunes

| Síntoma | Causa / arreglo |
|---|---|
| `beta_api_shape_disabled` en el panel | tu cuenta/modelo no tiene Realtime GA. Usá `gpt-realtime`. |
| Volta se auto-interrumpe | poné auriculares. Si sigue: subí `threshold` a `0.8` en `src/realtime.ts`. |
| Te corta antes de terminar la frase | subí `silence_duration_ms` a `1000` en `src/realtime.ts`. |
| Toma mucho ruido de ambiente | `noise_reduction: { type: "far_field" }` si hablás lejos del mic. |
| No se escucha nada | revisá permisos de micrófono y que el navegador no esté en mute. |
| Estática fuerte en el teléfono | el formato de audio no coincide. Corré `npm run check:pcmu`. |
| Twilio no llega al server | `PUBLIC_BASE_URL` desactualizado (ngrok rota el dominio) o falta el webhook en la consola. |
| La llamada saliente da 502 | credenciales de Twilio mal, o número no verificado (cuenta trial). |
| Un mensaje grabado pisa el saludo | cuenta trial de Twilio: verificá el número o pasá la cuenta a pago. |

---

## Archivos

| Archivo | Rol |
|---|---|
| `public/index.html` | Cliente: captura mic, reproduce, panel de mandato + tools. |
| `src/server.ts` | UI + rutas + router de upgrades WS (`/ws` y `/twilio/media`). |
| `src/realtime.ts` | Bridge con OpenAI Realtime (GA), agnóstico del transporte. |
| `src/twilio/routes.ts` | Webhooks TwiML (entrante / saliente / estado) + disparador. |
| `src/twilio/mediaStream.ts` | Adaptador Twilio Media Streams ↔ bridge. |
| `src/twilio/client.ts` | Cliente REST de Twilio (`placeCall`). |
| `src/audio/recorder.ts` | Graba la llamada a WAV μ-law en `data/audio/<callId>/`. |
| `scripts/check-pcmu.ts` | Valida contra la API real que μ-law está soportado. |
| `src/prompt.ts` | Instrucciones de Volta: `buildIntakeInstructions()` (jurado). |
| `src/tools.ts` | Tools del intake: `set_negotiation_mandate`, `record_call_note`, `end_intake`. |
| `src/mandateStore.ts` | Persiste el mandato en `data/mandate.json`. |
| `src/mandate.ts` | Motor de validación (se usa en la fase de negociación). |
| `src/store.ts` · `src/types.ts` · `src/config.ts` | Estado, tipos, config. |

---

## Auditoría

Cada llamada telefónica deja rastro verificable:

- `data/audio/<callId>/in.wav` y `out.wav` — μ-law 8 kHz, se abren en QuickTime,
  VLC o ffmpeg sin conversión.
- `GET /calls/<callId>` — el log completo, con `audioMs` en cada entrada.
- Cada compromiso lleva `agreedAtAudioMs`: el milisegundo del audio en el que se
  cerró. Abrís el WAV, saltás a ese punto y escuchás el precio que se acordó.

El reloj es el `media.timestamp` de Twilio, así que los dos canales y el log
comparten la misma línea de tiempo.

### Zona horaria

Un pickup sin zona explícita (`2026-09-03T08:00`) se interpreta con
`MANDATE_TZ_OFFSET` (default `-06:00`, México). Antes se leía en la hora local
del server: si el modelo mandaba `...T14:00:00Z` para las 8am de Manzanillo, la
ventana se corría 6 horas y se rechazaban pickups válidos.

---

## Qué sigue

- **Recap que habilite el compromiso:** hoy `propose_commitment` cuenta al
  instante. El SMS/email de recap debería ser lo que lo verifica.
- **3 negociaciones en paralelo** + comparador de cotizaciones. El flujo de
  negociación ya está en el código (`mode: "negotiate"`, `src/prompt.ts` →
  `buildInstructions`, tools `check_mandate` / `propose_commitment`).
- **Escalación a humano** en medio de la llamada: `needs_escalation` ya existe
  como veredicto, pero no tiene canal.
- **Persistir el log en disco:** el store es en memoria y se pierde al reiniciar.
  El audio sí queda.
