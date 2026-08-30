# Decision Log — TDtubbies

NextWave Hackathon 2026 · Buenos Aires

## 1. Elegimos OpenAI Realtime como motor principal de conversación por voz.  `T+07:54`

**Options considered**

- OpenAI Realtime
- ElevenLabs
- Pipeline STT → LLM → TTS

**Chosen:** OpenAI Realtime

**Why:** Necesitábamos conversación de voz de baja latencia, interrupciones naturales y tool calling durante la llamada. Realtime nos permite manejar estas capacidades en una única sesión.

## 2. Usamos Twilio como puente entre la red telefónica y nuestro agente.  `T+07:57`

**Options considered**

- Twilio
- ElevenLabs Phone
- Browser-only audio
- SIP directo

**Chosen:** Twilio

**Why:** El challenge requiere que el agente pueda interactuar mediante una llamada telefónica real. Twilio nos permite recibir y realizar llamadas y transportar el audio hacia nuestro backend, manteniendo separada la capa de telefonía de la inteligencia del agente.

## 3. Usamos ngrok para exponer nuestro servidor local a Twilio durante el desarrollo.  `T+07:59`

**Options considered**

- Port forwarding
- ngrok

**Chosen:** ngrok

**Why:** Twilio necesita acceder a un endpoint público, mientras desarrollábamos y probábamos el WebSocket localmente.

## 4. Usamos Firebase para persistir el estado y los datos relevantes de las negociaciones.  `T+08:01`

**Options considered**

- Firebase
- PostgreSQL
- MongoDB

**Chosen:** Firebase

**Why:** Firebase nos permitió almacenar el estado de las operaciones y mantener los datos disponibles entre sesiones y componentes del sistema.

## 5. Separamos la aplicación desplegada, la telefonía y el motor conversacional en diferentes capas.  `T+08:09`

**Options considered**

- Monolito único
- Twilio -> OpenAI directamente
- Frontend + backend + telefonía separados

**Chosen:** Backend → Twilio / OpenAI Realtime → Firebase

**Why:** Cada componente tiene una responsabilidad clara y era necesario hacer las divisiones para que quede todo estructurado

## 6. Simulamos dos de los tres carriers mediante agentes LLM y mantenemos una única llamada telefónica real.  `T+10:02`

**Options considered**

- - Tres llamadas telefónicas reales simultáneas
- - Una llamada real + dos carriers simulados por LLM
- - Tres carriers completamente simulados
- → Una llamada real + dos carriers simulados por LLM

**Chosen:** simulacion de dos carriers y una unica llamada real

**Why:** Para mantener una experiencia
telefónica real sin introducir la complejidad y latencia de gestionar tres
llamadas simultáneas, hacemos una llamada real con un carrier y simulamos los
otros dos mediante agentes LLM independientes.

## 7. Diseñamos el flujo con una llamada entrante al agente y una llamada saliente para coordinar el carrier. con 2 numeros de telefono distinto  `T+10:42`

**Options considered**

- - Dos llamadas independientes gestionadas por el mismo numero de telefono
- - Dos llamadas independientes gestionadas por distintos numeros de telefono

**Chosen:** Dos llamadas independientes gestionadas por distintos numeros de telefono

**Why:** Al utilizar 2 numeros de telefono distintos nos permitia diferenciar entre quien solicita los servicios de los carriers y el carrier

## 8. Cómo probar que quien encarga el flete es el cliente  `T+16:10`

**Options considered**

- Confiar en el caller ID
- Poner el código en el prompt y que el modelo lo valide
- Verificar el código en código, con intentos limitados y bloqueo por número

**Chosen:** Verificar el código en código, con intentos limitados y bloqueo por número

**Why:** Utilizando el codigo de verificación, nos permite aumentar la seguridad de que volta esta hablando con el cliente correcto y no hay ninguna estafa entre medio

## 9. Cómo hacer que un tercero levante Volta en minutos  `T+18:11`

**Options considered**

- Deployar a una nube (Fly/Railway) y dar una URL fija
- Dockerfile + docker-compose, corriendo en la máquina de quien evalúa
- Solo instrucciones en el README (npm install + .env a mano)

**Chosen:** Dockerfile + compose, con OPENAI_API_KEY como única variable obligatoria

**Why:** Es muy importante que las personas puedan levantar el repo de forma rapida y esta es la mas eficiente
