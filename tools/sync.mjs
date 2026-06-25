// Cálculo del desfase entre dos videos de YouTube por audio compartido.
// Reutilizado por el banco de pruebas (CLI) y por el backend del sitio.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateLag } from "../extension/lib/xcorr.js";
import { readWavMono } from "./wav.mjs";
import { downloadAudioSectionAsync, fetchMetaAsync } from "./ytaudio.mjs";

/**
 * Sincroniza N videos contra el PRIMERO (la referencia). Para cada otro video
 * devuelve `delta` = cuánto va la referencia por delante de él (cuando la
 * referencia está en t, ese video debe estar en t − delta).
 *
 * Descarga el audio de la referencia una sola vez. Si se alinea por hora de
 * inicio, elige la posición de la referencia para que TODAS las ventanas de los
 * seguidores caigan en tiempos válidos (≥ pos) y se solapen.
 *
 * @returns {{master:string, posMaster:number, win:number, startMs:number|null,
 *   duration:number|null, items:Array<{id,delta,confidence,lagSeconds,posF,startMs,duration}>}}
 */
export async function computeMulti(o) {
  const ids = o.ids;
  const pos = o.pos != null ? o.pos : 600;
  const win = o.win != null ? o.win : 30;
  const rate = o.rate != null ? o.rate : 8000;
  const align = o.align !== false;
  const ownDir = !o.dir;
  const dir = o.dir || mkdtempSync(join(tmpdir(), "ytds-multi-"));
  try {
    const master = ids[0];
    // Metadatos de todos los videos EN PARALELO.
    const metas = align ? await Promise.all(ids.map((id) => fetchMetaAsync(id))) : ids.map(() => null);
    const startMaster = metas[0] && metas[0].startMs;
    // Segundos que cada video empezó DESPUÉS de la referencia (0 si no se alinea).
    const shifts = ids.map((_, i) =>
      align && startMaster && metas[i] && metas[i].startMs ? (metas[i].startMs - startMaster) / 1000 : 0
    );
    const maxShift = Math.max(0, ...shifts);
    const posMaster = pos + maxShift; // así toda posF = posMaster − shift ≥ pos
    const positions = ids.map((_, i) => (i === 0 ? posMaster : Math.max(0, posMaster - shifts[i])));

    // Descargar el audio de TODOS los videos EN PARALELO (≈ el tiempo de uno solo).
    const wavs = await Promise.all(ids.map((id, i) => downloadAudioSectionAsync(id, positions[i], win, rate, dir)));
    const M = readWavMono(wavs[0]);

    const items = [];
    for (let i = 1; i < ids.length; i++) {
      const F = readWavMono(wavs[i]);
      const sr = Math.min(M.sampleRate, F.sampleRate);
      const r = estimateLag(M.samples, F.samples, sr);
      items.push({
        id: ids[i],
        delta: positions[0] - positions[i] - r.lagSeconds, // cuánto va la referencia por delante
        confidence: r.confidence,
        lagSeconds: r.lagSeconds,
        posF: positions[i],
        startMs: metas[i] ? metas[i].startMs : null,
        duration: metas[i] ? metas[i].duration : null,
      });
    }
    return {
      master, posMaster, win,
      startMs: startMaster || null,
      duration: metas[0] ? metas[0].duration : null,
      items,
    };
  } finally {
    if (ownDir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

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
export async function computeSync(o) {
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
      [metaA, metaB] = await Promise.all([fetchMetaAsync(idA), fetchMetaAsync(idB)]);
      if (metaA.startMs && metaB.startMs) {
        posB = posA - (metaB.startMs - metaA.startMs) / 1000;
      }
    }
    // Si la alineación empuja una posición a negativo, desplaza ambas.
    const shift = Math.min(0, posA, posB);
    posA -= shift;
    posB -= shift;

    const [wavA, wavB] = await Promise.all([
      downloadAudioSectionAsync(idA, posA, win, rate, dir),
      downloadAudioSectionAsync(idB, posB, win, rate, dir),
    ]);
    const A = readWavMono(wavA);
    const B = readWavMono(wavB);
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
