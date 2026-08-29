# Volta — Fase 1

Un agente de voz que hace **una** llamada saliente real y negocia dentro de un
mandato. El objetivo de esta fase es que Volta llame, converse, use sus tools
correctamente y registre todo. Sin paralelismo todavía (eso es Fase 3).

## Qué hace

1. Recibís un mandato por HTTP y Volta llama a un número real (Twilio).
2. Conversa por voz vía OpenAI Realtime (español/inglés, con barge-in).
3. Antes de aceptar cualquier trato, valida contra el mandato (`check_mandate`).
4. Registra compromisos válidos (`propose_commitment`) y notas (`record_call_note`).
5. Todo queda logueado en consola y en memoria (consultable por HTTP).

## Arquitectura (flujo de una llamada)

```
POST /calls (mandato)
      │
      ▼
Twilio crea la llamada ──▶ persona atiende ──▶ Twilio pide /twiml
      │                                              │
      │                                   TwiML: <Connect><Stream wss://…/media>
      ▼                                              │
  WS /media  ◀───────────── audio μ-law ────────────┘
      │  (RealtimeBridge)
      ▼
OpenAI Realtime  ──▶ audio de Volta ──▶ Twilio ──▶ persona
      │
      └──▶ tool calls ──▶ check_mandate / propose_commitment / record_call_note
```

Clave del diseño: **el modelo nunca decide solo si algo cabe en el mandato.**
Siempre pasa por `mandate.ts`, que es la única autoridad. Incluso
`propose_commitment` revalida en código antes de registrar nada.

## Archivos

| Archivo | Rol |
|---|---|
| `src/config.ts` | Carga y valida el `.env`. |
| `src/types.ts` | Tipos del dominio (Mandato, Compromiso, Log…). |
| `src/mandate.ts` | **Motor de mandato**: valida propuestas. |
| `src/store.ts` | Estado en memoria + logging. |
| `src/prompt.ts` | Construye las instrucciones de Volta con el mandato. |
| `src/tools.ts` | Esquema de las 3 tools + su ejecución. |
| `src/realtime.ts` | **Puente con OpenAI Realtime**: audio, tools, barge-in. |
| `src/server.ts` | Express + WS: dispara llamada, TwiML, media stream. |

## Requisitos

- Node.js 18+
- Cuenta de Twilio con un número de voz.
- Cuenta de OpenAI con acceso a la Realtime API.
- `ngrok` (o similar) para exponer el server en desarrollo.

## Setup

```bash
npm install
cp .env.example .env      # y completá tus credenciales
ngrok http 3000           # copiá el dominio a PUBLIC_HOST en .env
npm run dev
```

## Probar una llamada

```bash
curl -X POST https://TU-HOST.ngrok.app/calls \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+521XXXXXXXXXX",
    "mandate": {
      "origin": "Puerto de Manzanillo",
      "destination": "Bodega en Guadalajara",
      "containerNumber": "MSCU1234567",
      "maxPriceMxn": 9000,
      "pickupWindowStart": "2026-09-03T08:00",
      "pickupWindowEnd": "2026-09-03T18:00",
      "forbiddenConditions": ["pago por adelantado"]
    }
  }'
```

Ver el log/estado de esa llamada:

```bash
curl https://TU-HOST.ngrok.app/calls/<callId>
```

## Cómo verificar que funciona (checklist de Fase 2)

- [ ] Volta saluda y explica para qué llama.
- [ ] Si le tiran un precio, llama a `check_mandate` **antes** de aceptar.
- [ ] Si el precio supera el tope, no lo acepta ni aunque insistan.
- [ ] Un compromiso válido queda en `commitments` con sus términos.
- [ ] Si interrumpís a Volta, deja de hablar (barge-in).
- [ ] El log alcanza para reconstruir la conversación y las decisiones.

## Notas / cosas a ajustar

- **Nombres de eventos de la Realtime API**: la API evoluciona seguido. Si algo
  no dispara, revisá los nombres de eventos vigentes en la doc de OpenAI
  (`session.update`, `input_audio_buffer.append`, `response.audio.delta`,
  `input_audio_buffer.speech_started`, `response.function_call_arguments.done`).
- **Alternativa más simple**: OpenAI publica un *Agents SDK* con un adaptador de
  Twilio que maneja el forwarding de audio y las interrupciones por vos. Da menos
  control, pero si el bridge crudo te complica, es un buen plan B.
- **Formato de audio**: usamos `g711_ulaw` en ambos lados justamente para no
  transcodificar. Si cambiás a otra voz/idioma y suena raro, revisá esto primero.

## Qué sigue (Fase 2 y 3)

- Fase 2: recap por SMS + timestamp de audio en cada compromiso + una UI mínima.
- Fase 3: orquestador que llama a 3 transportistas en paralelo + `compare_quotes`
  + escalación en vivo.
