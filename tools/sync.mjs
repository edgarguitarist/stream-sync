// Cálculo del desfase entre dos videos de YouTube por audio compartido.
// Reutilizado por el banco de pruebas (CLI) y por el backend del sitio.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateLag } from "../extension/lib/xcorr.js";
import { readWavMono } from "./wav.mjs";
import { downloadAudioSection, fetchMeta } from "./ytaudio.mjs";

/**
 * Descubre el desfase entre dos videos.
 *
 * delta = posA − posB − lagAudio  →  "cuánto va A por delante de B" (segundos):
 * cuando A está en el tiempo t, B debe estar en t − delta para verse igual.
 *
 * @param {object} o
 * @param {string} o.idA, o.idB  ids de YouTube
 * @param {number} [o.pos=600]   posición nominal (s) de la ventana en A
 * @param {number} [o.posA] [o.posB] posiciones explícitas (anulan pos/align)
 * @param {number} [o.win=30]    duración de la ventana de audio (s)
 * @param {number} [o.rate=8000] tasa de muestreo (Hz)
 * @param {boolean}[o.align=true] pre-alinear posB con la hora de inicio del directo
 * @param {string} [o.dir]       carpeta temporal (se crea/borra si no se pasa)
 */
export function computeSync(o) {
  const { idA, idB } = o;
  const pos = o.pos != null ? o.pos : 600;
  const win = o.win != null ? o.win : 30;
  const rate = o.rate != null ? o.rate : 8000;
  const align = o.align !== false;
  const ownDir = !o.dir;
  const dir = o.dir || mkdtempSync(join(tmpdir(), "ytds-sync-"));

  try {
    let posA = o.posA != null ? o.posA : pos;
    let posB = o.posB != null ? o.posB : pos;
    let metaA = null, metaB = null;

    if (o.posA == null && o.posB == null && align) {
      metaA = fetchMeta(idA);
      metaB = fetchMeta(idB);
      if (metaA.startMs && metaB.startMs) {
        posB = posA - (metaB.startMs - metaA.startMs) / 1000;
      }
    }
    // Si la alineación empuja una posición a negativo, desplaza ambas.
    const shift = Math.min(0, posA, posB);
    posA -= shift;
    posB -= shift;

    const A = readWavMono(downloadAudioSection(idA, posA, win, rate, dir));
    const B = readWavMono(downloadAudioSection(idB, posB, win, rate, dir));
    const sr = Math.min(A.sampleRate, B.sampleRate);
    const r = estimateLag(A.samples, B.samples, sr);
    const delta = posA - posB - r.lagSeconds;

    return {
      idA, idB, posA, posB, win, rate,
      lagSeconds: r.lagSeconds,
      confidence: r.confidence,
      delta,
      startMsA: metaA ? metaA.startMs : null,
      startMsB: metaB ? metaB.startMs : null,
      durationA: metaA ? metaA.duration : null,
      durationB: metaB ? metaB.duration : null,
    };
  } finally {
    if (ownDir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  }
}
