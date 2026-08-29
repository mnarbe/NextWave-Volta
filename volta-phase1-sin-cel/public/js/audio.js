// ============================================================================
// audio.js — micrófono y parlantes del MODO NAVEGADOR (el fallback de demo).
// Dueño: llamada.
//
// Cuando la llamada va por teléfono esto queda dormido: el audio lo maneja
// Twilio y el navegador es solo pantalla.
//
//   captura:      mic -> PCM16 24 kHz -> base64 -> onChunk()
//   reproducción: base64 PCM16 -> AudioContext, encolado para que suene seguido
// ============================================================================

const SAMPLE_RATE = 24000; // lo que espera OpenAI Realtime (pcm16 mono 24 kHz)

let micCtx = null, micStream = null, micNode = null, micSource = null, micSink = null;
let outCtx = null, nextPlayTime = 0;
let scheduled = []; // fuentes agendadas, para poder cortarlas en barge-in

// --- conversiones ------------------------------------------------------------
function floatToPCM16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

// --- captura -----------------------------------------------------------------

// Abre el micrófono y llama a onChunk(base64) con cada fragmento.
export async function startCapture(onChunk) {
  // Contextos a 24 kHz: así no hay que remuestrear a mano.
  micCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  outCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  nextPlayTime = 0;

  // Cancelación de eco encendida (importante si no usás auriculares).
  // autoGainControl OFF: el AGC amplifica el ruido de fondo cuando no hablás y
  // hace que el VAD se dispare solo.
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
  });
  micSource = micCtx.createMediaStreamSource(micStream);

  // ScriptProcessor: deprecado pero simple y suficiente para la demo.
  micNode = micCtx.createScriptProcessor(4096, 1, 1);
  micNode.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0); // Float32 a 24 kHz
    onChunk(arrayBufferToBase64(floatToPCM16(input).buffer));
  };

  // Sink mudo para que el procesador corra sin devolverte tu propia voz.
  micSink = micCtx.createGain();
  micSink.gain.value = 0;
  micSource.connect(micNode);
  micNode.connect(micSink);
  micSink.connect(micCtx.destination);
}

export function stopCapture() {
  if (micNode) micNode.onaudioprocess = null;
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (micCtx) micCtx.close();
  if (outCtx) outCtx.close();
  micCtx = outCtx = micStream = micNode = micSource = micSink = null;
  scheduled = [];
  nextPlayTime = 0;
}

// --- reproducción ------------------------------------------------------------
export function playAudio(base64) {
  if (!outCtx) return;
  const int16 = base64ToInt16(base64);
  const f32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 0x8000;

  const buf = outCtx.createBuffer(1, f32.length, SAMPLE_RATE);
  buf.getChannelData(0).set(f32);
  const src = outCtx.createBufferSource();
  src.buffer = buf;
  src.connect(outCtx.destination);

  const t = Math.max(outCtx.currentTime, nextPlayTime);
  src.start(t);
  nextPlayTime = t + buf.duration;
  scheduled.push(src);
  src.onended = () => { scheduled = scheduled.filter((s) => s !== src); };
}

// Barge-in: cortar todo lo que esté sonando o agendado.
export function clearAudio() {
  for (const s of scheduled) { try { s.stop(); } catch {} }
  scheduled = [];
  nextPlayTime = outCtx ? outCtx.currentTime : 0;
}
