// -----------------------------------------------------------------------------
// routes/data.ts
// Lo que el dashboard (y quien quiera) lee del estado guardado.
// Dueño: base de datos. Si cambia dónde se guardan las cosas, cambia acá y en
// storage/, no en el resto del sistema.
// -----------------------------------------------------------------------------
import { Router } from "express";

import { getCall } from "../store.js";
import { getMandate } from "../storage/mandateStore.js";
import { getAllNegotiations } from "../storage/negotiationStore.js";

export const dataRoutes = Router();

// El mandato capturado del cliente.
// SYNC-READ: si la persistencia se vuelve asíncrona, este handler pasa a async.
dataRoutes.get("/mandate", (_req, res) => {
  res.json(getMandate());
});

// Estado de la negociación con carriers (una entrada por llamada).
// SYNC-READ: ídem.
dataRoutes.get("/negotiations", (_req, res) => {
  res.json(getAllNegotiations());
});

// Estado + log completo de una llamada. Vive en memoria (src/store.ts): se
// pierde al reiniciar, y es un buen primer candidato a persistir de verdad.
dataRoutes.get("/calls/:id", (req, res) => {
  const call = getCall(req.params.id);
  if (!call) return res.status(404).json({ error: "not_found" });
  res.json(call);
});
