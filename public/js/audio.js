// ============================================================================
// audio.js — microphone and speakers for BROWSER MODE (the demo fallback).
// Owner: call.
//
// When the call goes over the phone this stays asleep: Twilio handles the audio
// and the browser is only a screen.
//
//   capture:  mic -> PCM16 24 kHz -> base64 -> onChunk()
//   playback: base64 PCM16 -> AudioContext, queued so it plays back-to-back
// ============================================================================

const SAMPLE_RATE = 24000; // what OpenAI Realtime expects (pcm16 mono 24 kHz)

let micCtx = null, micStream = null, micNode = null, micSource = null, micSink = null;
let outCtx = null, nextPlayTime = 0;
let scheduled = []; // queued sources, so barge-in can cut them

// --- conversions -------------------------------------------------------------
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

// --- capture -----------------------------------------------------------------

// Opens the microphone and calls onChunk(base64) with every fragment.
export async function startCapture(onChunk) {
  // Contexts at 24 kHz, so there is nothing to resample by hand.
  micCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  outCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  nextPlayTime = 0;

  // Echo cancellation on (matters if you are not wearing headphones).
  // autoGainControl OFF: AGC amplifies background noise when you are not
  // talking and makes the VAD fire on its own.
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
  });
  micSource = micCtx.createMediaStreamSource(micStream);

  // ScriptProcessor: deprecated but simple and good enough for the demo.
  micNode = micCtx.createScriptProcessor(4096, 1, 1);
  micNode.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0); // Float32 at 24 kHz
    onChunk(arrayBufferToBase64(floatToPCM16(input).buffer));
  };

  // Muted sink so the processor runs without feeding your own voice back.
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

// --- playback ----------------------------------------------------------------
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

// Barge-in: cut everything playing or queued.
export function clearAudio() {
  for (const s of scheduled) { try { s.stop(); } catch {} }
  scheduled = [];
  nextPlayTime = outCtx ? outCtx.currentTime : 0;
}
