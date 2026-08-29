// -----------------------------------------------------------------------------
// audio/recorder.ts
// Graba el audio de una llamada telefónica a WAV μ-law (G.711), tal cual viene
// de Twilio: sin decodificar, sin resamplear. Dos archivos mono por llamada:
//
//   data/audio/<callId>/in.wav   <- lo que dijo la persona
//   data/audio/<callId>/out.wav  <- lo que dijo Volta
//
// Comparten un mismo reloj (media.timestamp de Twilio), así que el
// agreedAtAudioMs de un compromiso apunta al mismo instante en los dos.
//
// WAV con format code 7 (WAVE_FORMAT_MULAW): QuickTime, VLC y ffmpeg lo abren
// sin conversión.
// -----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, "..", "..", "data", "audio");

const SAMPLE_RATE = 8000;
const HEADER_BYTES = 58; // 12 RIFF + 26 fmt(18) + 12 fact + 8 data

// Header μ-law: fmt chunk de 18 bytes (cbSize=0) + chunk "fact", que es lo que
// pide la spec para formatos no-PCM.
function mulawHeader(dataBytes: number): Buffer {
  const b = Buffer.alloc(HEADER_BYTES);
  let o = 0;
  b.write("RIFF", o); o += 4;
  b.writeUInt32LE(HEADER_BYTES - 8 + dataBytes, o); o += 4;
  b.write("WAVE", o); o += 4;

  b.write("fmt ", o); o += 4;
  b.writeUInt32LE(18, o); o += 4;          // tamaño del fmt chunk
  b.writeUInt16LE(7, o); o += 2;           // 7 = WAVE_FORMAT_MULAW
  b.writeUInt16LE(1, o); o += 2;           // mono
  b.writeUInt32LE(SAMPLE_RATE, o); o += 4;
  b.writeUInt32LE(SAMPLE_RATE, o); o += 4; // byte rate (8 bits por sample)
  b.writeUInt16LE(1, o); o += 2;           // block align
  b.writeUInt16LE(8, o); o += 2;           // bits por sample
  b.writeUInt16LE(0, o); o += 2;           // cbSize

  b.write("fact", o); o += 4;
  b.writeUInt32LE(4, o); o += 4;
  b.writeUInt32LE(dataBytes, o); o += 4;   // samples totales

  b.write("data", o); o += 4;
  b.writeUInt32LE(dataBytes, o); o += 4;
  return b;
}

class Track {
  private fd: number;
  private bytes = 0;
  constructor(file: string) {
    this.fd = fs.openSync(file, "w");
    // Header provisorio; al cerrar reescribimos con los tamaños reales.
    fs.writeSync(this.fd, mulawHeader(0));
  }
  append(chunk: Buffer) {
    fs.writeSync(this.fd, chunk);
    this.bytes += chunk.length;
  }
  close() {
    try {
      fs.writeSync(this.fd, mulawHeader(this.bytes), 0, HEADER_BYTES, 0);
      fs.closeSync(this.fd);
    } catch {
      /* noop */
    }
  }
  get size() {
    return this.bytes;
  }
}

export class CallRecorder {
  private inTrack: Track;
  private outTrack: Track;
  private dir: string;
  private closed = false;

  constructor(callId: string) {
    this.dir = path.join(AUDIO_DIR, callId);
    fs.mkdirSync(this.dir, { recursive: true });
    this.inTrack = new Track(path.join(this.dir, "in.wav"));
    this.outTrack = new Track(path.join(this.dir, "out.wav"));
  }

  // base64 μ-law, tal cual llega de Twilio / de OpenAI.
  writeInbound(base64: string) {
    if (!this.closed) this.inTrack.append(Buffer.from(base64, "base64"));
  }
  writeOutbound(base64: string) {
    if (!this.closed) this.outTrack.append(Buffer.from(base64, "base64"));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.inTrack.close();
    this.outTrack.close();
  }

  get paths() {
    return {
      dir: this.dir,
      inbound: path.join(this.dir, "in.wav"),
      outbound: path.join(this.dir, "out.wav"),
      // 8000 bytes = 1 segundo en μ-law 8kHz.
      inboundMs: Math.round((this.inTrack.size / SAMPLE_RATE) * 1000),
      outboundMs: Math.round((this.outTrack.size / SAMPLE_RATE) * 1000),
    };
  }
}
