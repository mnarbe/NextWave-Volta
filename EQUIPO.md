# Cómo trabajamos los tres sin pisarnos

La regla es una sola: **una carpeta, un dueño**. Si tenés que editar un archivo
de otro, avisá antes — no porque esté prohibido, sino porque es la única forma
de que un merge no nos coma una hora.

> El código y los comentarios están en inglés (así quedó `main`). Este documento
> y la guía de equipo, en castellano.

---

## Quién toca qué

### 🎨 Diseño

| Archivo | Qué es |
| --- | --- |
| `public/index.html` | La estructura de la página. Solo markup. |
| `public/styles.css` | Todo el aspecto. Ningún JS escribe estilos inline. |
| `public/js/render.js` | Todo lo que dibuja: tarjetas, badges, paneles, mensajes. |

Podés reescribir el interior de `render.js` entero: mientras las funciones
exportadas sigan existiendo con el mismo nombre, no rompés nada. Si agregás un
elemento que el JS tiene que tocar, dale un `id` y sumalo al objeto `ui` que está
arriba de `render.js`.

**No toques:** `public/js/client.js` (es de llamada).

### 🗄️ Base de datos

| Archivo | Qué es |
| --- | --- |
| `src/store/paths.ts` | **El único archivo del proyecto que toca el disco.** |
| `src/store/mandates.ts` | El mandato del cliente. |
| `src/store/negotiations.ts` | Las negociaciones con carriers. |
| `src/store/calls.ts` | Estado y log de cada llamada (hoy solo en memoria). |
| `src/domain/` | Tipos, validación del mandato y valores por defecto. |
| Los endpoints de lectura en `src/http/routes.ts` | `/mandate`, `/negotiations`, `/calls/:id`. |

Para migrar a una base de datos de verdad, cambiás `paths.ts` (`readJson` /
`writeJson`) y listo: `tools.ts`, `session.ts` y las rutas no se enteran.

**Ojo con esto:** hoy la lectura es **síncrona**. Un driver síncrono
(better-sqlite3) entra sin tocar nada más. Si elegís uno asíncrono (Postgres,
Mongo), hay lugares que leen sin poder esperar — están marcados con el
comentario `SYNC-READ`, y hay que volverlos `async` a mano. Buscalos antes de
decidir el motor:

```bash
grep -rn "SYNC-READ" src/
```

`src/store/calls.ts` vive solo en memoria: se pierde al reiniciar, y es el mejor
primer candidato a persistir de verdad.

**No toques:** `src/agent/` ni `src/telephony/` (son de llamada).

### 📞 Llamada

| Archivo | Qué es |
| --- | --- |
| `src/agent/realtime.ts` | El puente con OpenAI Realtime. Códec, VAD, barge-in. |
| `src/agent/prompts.ts` | Lo que Volta sabe y cómo negocia. |
| `src/agent/tools.ts` | Las tools que puede llamar el modelo. |
| `src/telephony/stream.ts` | El transporte teléfono: audio μ-law ↔ OpenAI. |
| `src/telephony/twilio.ts` | TwiML, llamadas salientes, config del número. |
| `src/http/telephony.ts` | Webhooks de Twilio y API de control. |
| `src/http/ws.ts` | Los dos WebSockets + el transporte navegador. |
| `public/js/client.js`, `public/js/audio.js` | El cliente del dashboard y el audio del navegador. |
| `scripts/` | Setup de Twilio y el simulador de llamadas. |

**No toques:** `public/js/render.js` ni `src/store/`.

### 🤝 De todos (avisar antes de tocar)

`src/index.ts`, `src/config.ts`, `src/session.ts`, `src/bus.ts`,
`src/http/routes.ts`, `package.json`.

Son chicos y estables a propósito. Si estás por meter lógica en `index.ts`, casi
seguro va en `http/`, en `agent/` o en `telephony/`.

---

## Los contratos que no se rompen sin avisar

Son las tres costuras por donde se tocan las áreas. Cambiar una rompe el trabajo
de otro, así que se avisa en voz alta.

1. **`store` ⇄ el resto.** `getMandate()`, `saveMandate()`, `recordOffer()`,
   `finalizeNegotiation()`, `getAllNegotiations()`. Base de datos puede cambiar
   *cómo* guardan; los nombres y las formas que devuelven, no.

2. **backend ⇄ dashboard.** Los eventos que viajan por el WebSocket:
   `user_transcript`, `agent_transcript`, `mandate_captured`, `carrier_offer`,
   `carrier_refusal`, `intake_done`, `negotiation_done`, `phone_call_started`,
   `phone_call_ended`. Están todos en el `switch` de `client.js`. Llamada agrega
   eventos nuevos; diseño decide cómo se ven.

3. **`client.js` ⇄ `render.js`.** Las funciones exportadas de `render.js`. Diseño
   manda adentro, llamada manda cuándo se llaman.

---

## Git

Una rama por área, siempre partiendo de `main`:

```bash
git checkout main
git pull
git checkout -b diseno/panel-carriers      # o datos/... o llamada/...
```

- **Commits chicos y seguido.** Un commit que toca 8 archivos es un conflicto
  esperando.
- **Mergeá a `main` seguido** — al menos una vez por bloque de trabajo. Las ramas
  largas son las que duelen: ya nos pasó una vez que dos reestructuraciones
  distintas chocaron y hubo que resolverlas a mano.
- **Antes de mergear:** `npm run typecheck`. Tiene que pasar limpio.
- **`data/` y `.env` están en `.gitignore`.** Nunca se commitean: son estado
  local de cada máquina, y el `.env` tiene secretos.

---

## Lo único que NO se puede paralelizar: el teléfono

El número **+1 585 601 1456 apunta a una sola máquina a la vez**. El webhook de
Twilio guarda una URL, y `npm run setup:twilio` la pisa con la de quien lo corra
último. Si los tres lo corren, se roban las llamadas entre sí.

**Acordamos una "máquina de demo"** — la que tiene el túnel de ngrok levantado y
el webhook apuntándole. Es la única que corre `setup:twilio`.

Los otros dos trabajan sin tocar el número:

```bash
npm run dev            # server local, sin túnel
npm run test:stream    # se hace pasar por Twilio: prueba el camino de audio
                       # completo sin gastar una llamada ni robar el webhook
```

Y para probar la conversación entera hablando, está el botón **🎙 Browser mode**
del dashboard, que usa el micrófono de tu máquina como si fuera la línea. Sirve
para todo salvo para probar Twilio en sí.

Si te toca ser la máquina de demo y el túnel se te cae, el dashboard te lo avisa
en rojo ("tunnel down") antes de que lo descubras con el jurado al teléfono.
