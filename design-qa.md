# Design QA — Living Manifest oscuro

## Resultado

**PASS** — sin hallazgos P0, P1 o P2 abiertos.

## Referencia y estados comparados

- Referencia: `design-explorations/references/living-manifest-dark-conversation.png`
- Implementación desktop: `design-explorations/production-qa/production-desktop-drawer-final.png`
- Implementación mobile, conversación: `design-explorations/production-qa/production-mobile-drawer-final.png`
- Implementación mobile, resumen: `design-explorations/production-qa/production-mobile-overview-final.png`
- La referencia y la captura desktop final se revisaron juntas en el mismo pase visual.

## Checklist visual

- [x] Tono grafito cálido, coral y verde apagado consistente con la dirección elegida.
- [x] Mandato, tres tickets y decisión se comprenden como una secuencia visual.
- [x] La oferta de 8.250 MXN se muestra como más barata pero inválida por demora.
- [x] La conversación se abre desde cada ticket sin perder el contexto de la comparación.
- [x] Transcripción, evidencia, historial y actividad técnica usan progressive disclosure.
- [x] En mobile, mandato y decisión aparecen antes de la lista de carriers.
- [x] Sin scroll horizontal de página en la verificación mobile (~390 px); los controles visibles mantienen un área mínima de 44 px.
- [x] Se verificaron ganador, sin ganador limpio, intervención humana, desconexión, llamada activa y carrier negociando.
- [x] No se observaron cortes, solapamientos o bordes/radios inconsistentes en los estados finales.

## Compatibilidad y comportamiento

- [x] Se preservaron los 21 exports públicos de `render.js`.
- [x] Se preservaron los IDs utilizados por `client.js`.
- [x] Los tres tickets abren la conversación correcta; tabs, cierre, scrim y Escape funcionan.
- [x] La aplicación real responde contra el backend local y carga el estado vacío sin errores visibles.
- [x] `npm run typecheck`, `node --check` y `git diff --check` completaron sin errores (solo avisos de fin de línea de Git).

## Diferencias deliberadas respecto del mock

- La implementación usa los nombres y contratos reales del repositorio en lugar de metadatos ficticios de operador.
- El drawer prioriza conversación y evidencia en tabs; la actividad técnica y el historial quedan colapsados.
- Los controles de la aplicación real se conservan en la cabecera y pasan a una banda desplazable en mobile.

## Hallazgos cerrados durante QA

- **P2 — scroll horizontal mobile:** el pseudo-elemento de ganador no heredaba `box-sizing`; corregido y revalidado.
- **P3 — horarios truncados:** se forzó formato de 24 horas para timestamps operativos.
- **P3 — compresión desktop con drawer:** se ajustó el ancho del panel y la proporción del layout abierto.
