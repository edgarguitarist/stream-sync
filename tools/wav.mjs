// Lector de WAV mínimo (PCM 8/16/32-bit y float32) → Float32Array mono.
import { readFileSync } from "node:fs";

/** Lee un .wav y devuelve { sampleRate, samples: Float32Array } promediando canales. */
export function readWavMono(path) {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("no es un WAV válido: " + path);
  }
  let off = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataOff = body;
      dataLen = Math.min(size, buf.length - body);
    }
    off = body + size + (size & 1); // chunks alineados a 2 bytes
  }
  if (!fmt || dataOff < 0) throw new Error("WAV sin fmt/data: " + path);

  const { channels, sampleRate, bitsPerSample, audioFormat } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(dataLen / (bytesPerSample * channels));
  const out = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) {
      const p = dataOff + (i * channels + c) * bytesPerSample;
      let v = 0;
      if (bitsPerSample === 16) v = buf.readInt16LE(p) / 32768;
      else if (bitsPerSample === 32 && audioFormat === 3) v = buf.readFloatLE(p);
      else if (bitsPerSample === 32) v = buf.readInt32LE(p) / 2147483648;
      else if (bitsPerSample === 8) v = (buf.readUInt8(p) - 128) / 128;
      s += v;
    }
    out[i] = s / channels;
  }
  return { sampleRate, samples: out };
}
