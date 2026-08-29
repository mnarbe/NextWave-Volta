# Volta — agente de voz por teléfono (Twilio + OpenAI Realtime)

Volta atiende y hace **llamadas telefónicas reales** en el número
**+1 585 601 1456**. Habla en inglés, le saca al cliente el **precio máximo en
MXN**, y después **llama a los carriers** para negociar contra ese tope. Todo lo
que pasa en la llamada se ve en vivo en el dashboard web.

El navegador ya no es la línea: es la pantalla. (El modo micrófono sigue estando
como fallback por si en la demo falla el teléfono.)

> **¿Trabajás en equipo?** Leé [docs/EQUIPO.md](../docs/EQUIPO.md): quién toca
> qué carpeta, los contratos entre áreas, y por qué el teléfono apunta a una
> sola máquina a la vez.

---

## Cómo está armado

```
        llamada entrante                          llamada saliente
   cliente ──> +1 585 601 1456              Volta ──> carrier
                    │                                    │
              POST /twilio/voice                  POST /call  (REST API)
                    │  devuelve TwiML                     │
                    ▼                                     ▼
            <Connect><Stream url="wss://…/twilio/media"/>
                             │
                             ▼  WebSocket bidireccional, G.711 μ-law 8 kHz
                   ┌──────────────────┐
                   │  /twilio/media   │  passthrough de audio, sin transcodificar
                   └────────┬─────────┘
                            ▼
                 OpenAI Realtime (gpt-realtime)
                   audio.format = "audio/pcmu"
                            │
                     tools + transcripts
                            ▼
                   bus ──> dashboard (/ws)
```

El truco que mantiene esto simple: la Realtime API GA habla **G.711 μ-law 8 kHz**
(`audio/pcmu`) nativo, que es exactamente el códec de Twilio Media Streams. El
audio va y viene en base64 sin remuestrear ni convertir en ningún lado.

Cada carpeta tiene un dueño (ver [docs/EQUIPO.md](../docs/EQUIPO.md)):

| Archivo | Rol | Dueño |
| --- | --- | --- |
| `src/server.ts` | Cableado: monta rutas y WebSockets. Casi nunca se toca. | todos |
| `src/routes/telephony.ts` | Webhooks de Twilio + API de control (llamar, colgar, health). | llamada |
| `src/routes/data.ts` | Lectura del estado guardado. | datos |
| `src/voice/twilioStream.ts` | Transporte teléfono: `/twilio/media` ↔ OpenAI. | llamada |
| `src/voice/browserStream.ts` | Transporte navegador + socket del dashboard. | llamada |
| `src/voice/realtime.ts` | Puente con OpenAI. Elige el códec según el transporte. | llamada |
| `src/voice/twilio.ts` | TwiML, llamadas salientes, config del número, geo-permisos. | llamada |
| `src/voice/prompt.ts` · `src/voice/tools.ts` | Qué sabe Volta y qué puede hacer. | llamada |
| `src/storage/persistence.ts` | El único archivo que toca el disco. | datos |
| `src/storage/mandateStore.ts` · `negotiationStore.ts` | Mandato y negociaciones. | datos |
| `src/session.ts` | Arrancar una llamada, común a los dos transportes. | todos |
| `src/bus.ts` | Fan-out de eventos a los dashboards. | todos |
| `public/index.html` · `public/styles.css` | Estructura y aspecto del dashboard. | diseño |
| `public/js/render.js` | Todo lo que dibuja. | diseño |
| `public/js/client.js` · `public/js/audio.js` | WebSocket, teléfono y micrófono. | llamada |
| `scripts/setup-twilio.ts` | Deja Twilio configurado sin entrar a la consola. | llamada |
| `scripts/fake-twilio.mjs` | Se hace pasar por Twilio para probar sin gastar llamadas. | llamada |

---

## Setup

**Requisitos:** Node 20+, una API key de OpenAI con Realtime GA (`gpt-realtime`),
una cuenta paga de Twilio con un número, y un túnel público a este puerto
(ngrok) porque Twilio tiene que poder alcanzar tu máquina.

```bash
npm install
cp .env.example .env    # y completá las claves
```

`.env`:

```ini
OPENAI_API_KEY=sk-...
TWILIO_ACCOUNT_SID=AC...          # Console > Account Info
TWILIO_AUTH_TOKEN=...             # ídem
TWILIO_NUMBER=+15856011456
PUBLIC_URL=https://tu-tunel.ngrok-free.dev
```

Levantá el túnel (dominio fijo, así la URL no cambia entre corridas):

```bash
ngrok http 3000
```

Y dejá el número apuntando a esta máquina — esto reemplaza a editar el webhook a
mano en la consola de Twilio:

```bash
npm run setup:twilio
```

El script detecta la URL de ngrok sola (la lee de la API local del agente y la
escribe en `.env` si falta), valida las credenciales, apunta el `voiceUrl` del
número a `/twilio/voice`, y avisa si el país al que vas a llamar está bloqueado
por geo-permisos. Pasale un destino para que lo chequee:

```bash
npm run setup:twilio -- +5215512345678
```

---

## Correrlo

```bash
npm run dev
```

Abrí **http://localhost:3000** — ese es el dashboard, no hace falta apretar nada.

**1. Intake.** Llamá desde tu celular al **+1 585 601 1456**. Volta atiende, se
presenta y te pide el envío y el precio máximo. Cuando tiene el número firme
llama a `set_negotiation_mandate`, te confirma el brief y **corta ella**. El
mandato queda en `data/mandate.json` y en grande en el dashboard.

**2. Negociación.** En la barra de arriba del dashboard poné el número del
carrier en formato E.164 y apretá **Llamar al carrier**. Volta marca, negocia
contra el tope, registra cada oferta/condición/demora, y cierra. Repetí con cada
carrier: cada uno queda como una tarjeta en "Negociación con carriers".

Volta cuelga sola cuando termina: antes de cortar manda un `mark` a Twilio y
espera a que vuelva, así no se corta la última frase por la mitad.

### Sin teléfono (fallback de demo)

El botón **🎙 Modo navegador** hace lo de antes: el micrófono de esta máquina es
la línea. Sirve si en el escenario no hay señal o se cae el túnel. Usá
auriculares.

### Probar sin gastar llamadas

```bash
npm run test:stream
```

Se hace pasar por Twilio contra `/twilio/media`, y guarda lo que dice Volta en
`volta-greeting.wav`. Si eso suena, el camino del audio está sano.

---

## Endpoints

| Método | Ruta                  | Qué hace                                              |
| ------ | --------------------- | ----------------------------------------------------- |
| POST   | `/twilio/voice`       | Webhook de llamada entrante → TwiML con el `<Stream>` |
| POST   | `/twilio/status`      | Ciclo de vida de la llamada (log)                     |
| WSS    | `/twilio/media`       | Audio μ-law ↔ OpenAI                                  |
| POST   | `/call`               | Volta llama: `{"to":"+52...","carrier":"..."}`        |
| POST   | `/call/:sid/hangup`   | Cortar una llamada en curso                           |
| GET    | `/twilio/health`      | Si el teléfono está listo y con qué URLs               |
| POST   | `/twilio/setup`       | Apuntar el número a esta máquina                      |
| GET    | `/twilio/geo?to=+52…` | Si Twilio deja llamar a ese país                       |
| GET    | `/mandate`            | El mandato capturado                                  |
| GET    | `/negotiations`       | Negociaciones con carriers                            |
| GET    | `/calls/:id`          | Estado + log completo de una llamada                  |
| WSS    | `/ws`                 | Dashboard (y modo micrófono)                          |

Los webhooks verifican la firma `X-Twilio-Signature`. Para pegarles con `curl`,
poné `TWILIO_VALIDATE_SIGNATURE=0`.

---

## Problemas comunes

| Síntoma                                    | Causa / arreglo                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| "We're sorry, an application error has occurred" | Twilio no llegó al webhook (error 11200). Casi siempre **ngrok se cayó**: la barra del dashboard lo dice ("túnel caído"). Levantalo con el dominio fijo:<br>`ngrok http 3000 --url=https://TU-DOMINIO.ngrok-free.dev`<br>Si el dominio cambió, corré `npm run setup:twilio` para reapuntar el número. |
| Error 21215 al llamar al carrier           | País bloqueado en Voice → Geographic Permissions. `GET /twilio/geo?to=+52…`.     |
| `invalid signature` en el log              | `PUBLIC_URL` no coincide con la URL real del webhook.                            |
| Volta habla encima del carrier             | Subí `threshold` en `turnDetection()` de `src/realtime.ts`.                      |
| Te interrumpe apenas hacés una pausa       | Subí `silence_duration_ms` en el mismo lugar.                                    |
| Corta la última frase                      | El `mark` no volvió: revisá el log de `/twilio/media`.                           |
| `beta_api_shape_disabled`                  | Tu cuenta no tiene Realtime GA. Usá `gpt-realtime`.                              |
