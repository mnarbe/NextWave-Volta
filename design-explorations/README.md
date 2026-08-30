# Volta — visual explorations

Tres prototipos estáticos e independientes. Cada dirección tiene su propio HTML, CSS y JavaScript, usa los datos representativos del mandato y permite alternar entre resultado, ausencia de ganador, desconexión e intervención humana.

## A — Negotiation Flow

- Visualización principal: flujo ramificado que conecta mandato, tres llamadas y decisión.
- La causalidad domina: el recorrido válido llega a la decisión; los rechazos se cortan y explican en el punto de falla.
- Ventaja: mejor lectura narrativa y mejor demostración del trabajo paralelo.
- Riesgo: el diagrama necesita cuidado al sumar carriers o estados muy largos.

## B — Market Pulse

- Visualización principal: campo de precios con el máximo como referencia y una segunda capa de elegibilidad.
- Separa visualmente “más barato” de “válido”, por eso 8.250 MXN no parece ganador.
- Ventaja: comparación instantánea y buena adaptación a datos en vivo.
- Riesgo: una escala extrema o demasiados carriers puede requerir agrupación o zoom.

## C — Living Manifest

- Visualización principal: manifiesto operativo con despachos de carrier y sellos de validación.
- La decisión queda registrada como una adjudicación documental, cálida y memorable.
- Ventaja: personalidad más propia y excelente encaje con logística.
- Riesgo: exige disciplina para no caer en decoración ni perder densidad útil en mobile.

## Recomendación

Market Pulse es la base más sólida para la interfaz final: explica el máximo, el precio de cada carrier y la elegibilidad en pocos segundos; mantiene baja la carga visual, escala bien a estados dinámicos y se integra con `CarrierNegotiation`, `RankedCarrier` y `RoundDecision` sin transformar datos. Tomaría de Negotiation Flow la animación breve de conexiones y de Living Manifest el tono editorial, pero conservaría el campo de precios como visualización central.
