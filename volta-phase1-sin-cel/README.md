# Volta — Fase 0 (intake con el jurado)

Agente de voz que corre **en el navegador** (micrófono + parlantes) contra la
**OpenAI Realtime API (GA)**. En esta fase Volta habla en **inglés** con el
*jurado* (el que le encarga el transporte), le saca el **precio máximo en MXN**,
lo guarda y le corta la llamada. Ese precio se usa después para negociar con los
proveedores (fase 2, todavía no hecha).

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
OPENAI_API_KEY=sk-...            # obligatorio
OPENAI_REALTIME_MODEL=gpt-realtime   # opcional (default gpt-realtime)
PORT=3000                        # opcional
```

`.env`, `node_modules/` y `data/` están en `.gitignore` — no se commitean.

---

## Correrlo

```bash
npm run dev      # tsx watch: recarga solo al editar
```

Vas a ver:

```
Volta (sin celular) escuchando en http://localhost:3000
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
| GET | `/calls/:id` | estado + log completo de una llamada |

---

## Problemas comunes

| Síntoma | Causa / arreglo |
|---|---|
| `beta_api_shape_disabled` en el panel | tu cuenta/modelo no tiene Realtime GA. Usá `gpt-realtime`. |
| Volta se auto-interrumpe | poné auriculares. Si sigue: subí `threshold` a `0.8` en `src/realtime.ts`. |
| Te corta antes de terminar la frase | subí `silence_duration_ms` a `1000` en `src/realtime.ts`. |
| Toma mucho ruido de ambiente | `noise_reduction: { type: "far_field" }` si hablás lejos del mic. |
| No se escucha nada | revisá permisos de micrófono y que el navegador no esté en mute. |

---

## Archivos

| Archivo | Rol |
|---|---|
| `public/index.html` | Cliente: captura mic, reproduce, panel de mandato + tools. |
| `src/server.ts` | Sirve la UI + WS que puentea navegador ↔ OpenAI. `GET /mandate`. |
| `src/realtime.ts` | Bridge con OpenAI Realtime (GA, PCM16 24 kHz) + eventos a la UI. |
| `src/prompt.ts` | Instrucciones de Volta: `buildIntakeInstructions()` (jurado). |
| `src/tools.ts` | Tools del intake: `set_negotiation_mandate`, `record_call_note`, `end_intake`. |
| `src/mandateStore.ts` | Persiste el mandato en `data/mandate.json`. |
| `src/mandate.ts` | Motor de validación (se usa en la fase de negociación). |
| `src/store.ts` · `src/types.ts` · `src/config.ts` | Estado, tipos, config. |

---

## Qué sigue

- **Fase 2:** 3 proveedores simulados (cada uno su API key + personalidad: uno
  caro, uno regateador, uno que baja a algo razonable). Volta negocia contra el
  precio guardado. El flujo de negociación ya está parkeado en el código
  (`mode: "negotiate"`, `src/prompt.ts` → `buildInstructions`, tools
  `check_mandate` / `propose_commitment`).
- **Fase 3:** comparador de las 3 negociaciones + escalación.
