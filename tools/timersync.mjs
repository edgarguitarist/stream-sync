// Sync por el TIMER del juego mediante correlación visual de su franja.
//
// Idea: el timer/HUD del juego es CONTENIDO COMPARTIDO entre POV (todos ven el
// mismo reloj). Aislando la franja superior-central y restando la media temporal
// de cada píxel (background subtraction), queda solo lo que VARÍA —el timer—
// libre del fondo distinto de cada mapa. La cross-correlación temporal de esa
// señal entre dos POV da el desfase con un pico nítido, sin necesidad de LEER el
// número (robusto a la fuente estilizada, donde el OCR falla).
//
// En directos, yt-dlp ignora la posición y entrega el borde en vivo; por eso las
// descargas se lanzan EN PARALELO (mismo instante de pared aproximado) y el lag
// medido es el desfase de transmisión real entre POV. El mapeo a currentTime del
// reproductor lo da la hora de inicio:  delta = shift(inicio) − lag.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fetchMetaAsync, cleanPartials } from "./ytaudio.mjs";

const FPS = 8;            // muestras/seg de la franja
const W = 128, H = 56;    // franja remuestreada (px) — compromiso nitidez/coste
const THRESH = 150;       // umbral de blanco del HUD
const ROI = { x: 0.42, y: 0.03, w: 0.18, h: 0.14 }; // franja superior-central
const MAXLAG = 25;        // s de búsqueda a cada lado

/** Descarga async de [pos, pos+dur] s de video a ≤720p (mp4). En directo, pos se
 *  ignora y se obtiene el borde en vivo. Nunca rechaza sin reintentar. */
function downloadVideoSectionAsync(id, pos, dur, outDir, height = 360, attempts = 2) {
  const base = join(outDir, `${id}_${Math.round(pos)}_${Math.round(dur)}_${height}`);
  const mp4 = `${base}.mp4`;
  if (existsSync(mp4)) return Promise.resolve(mp4);
  const args = ["-m", "yt_dlp", "-q", "--no-warnings",
    "-f", `bv*[height<=${height}]/wv*[height<=${height + 120}]/worstvideo`,
    "--download-sections", `*${pos}-${pos + dur}`,
    "--force-keyframes-at-cuts", "--recode-video", "mp4",
    "-o", `${base}.%(ext)s`, `https://www.youtube.com/watch?v=${id}`];
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryOnce = () => {
      attempt++;
      const child = spawn("python", args, { timeout: 120000 });
      let err = "", settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (existsSync(mp4)) return resolve(mp4);
        cleanPartials(outDir, basename(base));
        if (attempt < attempts) return tryOnce();
        reject(new Error(`descarga de video falló (${id}): ${err.slice(-200) || "sin salida"}`));
      };
      child.stderr.on("data", (c) => (err += c));
      child.on("error", (e) => { err += " " + String((e && e.message) || e); done(); });
      child.on("close", done);
    };
    tryOnce();
  });
}

/** Extrae la franja del timer como rawvideo gris binarizado (Promise<Buffer>). */
function extractStripRaw(mp4) {
  const { x, y, w, h } = ROI;
  const vf = [`fps=${FPS}`, `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y}`, `scale=${W}:${H}`,
    `format=gray`, `lut=y='gte(val,${THRESH})*255'`].join(",");
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-i", mp4, "-vf", vf, "-f", "rawvideo", "-"]);
    const chunks = [];
    let err = "";
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return reject(new Error("ffmpeg no extrajo franja: " + err.slice(-200)));
      resolve(buf);
    });
  });
}

/** Buffer crudo → frames centrados temporalmente (resta la media por píxel). */
function toCenteredFrames(buf) {
  const fsz = W * H, n = Math.floor(buf.length / fsz);
  const frames = [];
  for (let f = 0; f < n; f++) {
    const m = new Float32Array(fsz), o = f * fsz;
    for (let p = 0; p < fsz; p++) m[p] = buf[o + p] > 127 ? 1 : 0;
    frames.push(m);
  }
  const mean = new Float32Array(fsz);
  for (const f of frames) for (let p = 0; p < fsz; p++) mean[p] += f[p];
  for (let p = 0; p < fsz; p++) mean[p] /= (n || 1);
  for (const f of frames) for (let p = 0; p < fsz; p++) f[p] -= mean[p];
  return frames;
}

/** Similitud coseno de A[t] vs B[t+d] promediada sobre el solape. */
function scoreAt(A, B, d, fsz) {
  let s = 0, na = 0, nb = 0;
  const t0 = Math.max(0, -d), t1 = Math.min(A.length, B.length - d);
  if (t1 - t0 < FPS * 4) return 0; // exige solape mínimo (4 s)
  for (let t = t0; t < t1; t++) {
    const a = A[t], b = B[t + d];
    for (let p = 0; p < fsz; p++) { s += a[p] * b[p]; na += a[p] * a[p]; nb += b[p] * b[p]; }
  }
  return (na === 0 || nb === 0) ? 0 : s / Math.sqrt(na * nb);
}

/**
 * Cross-correlación temporal master↔follower.
 * @returns {{lagSeconds, confidence, score}} lagSeconds>0 = follower retrasado.
 *   confidence = pico/media (≫1 = señal de timer clara; ~1 = sin señal fiable).
 */
function correlate(master, follower) {
  const fsz = W * H, maxd = Math.round(MAXLAG * FPS);
  let best = { d: 0, score: -Infinity }, sum = 0, count = 0;
  for (let d = -maxd; d <= maxd; d++) {
    const sc = scoreAt(master, follower, d, fsz);
    sum += sc; count++;
    if (sc > best.score) best = { d, score: sc };
  }
  const mean = count ? sum / count : 0;
  const confidence = mean > 1e-6 ? best.score / mean : 0;
  return { lagSeconds: best.d / FPS, confidence, score: best.score };
}

/**
 * Calcula el desfase por timer de N videos contra el primero (referencia).
 * @param {{ids:string[], pos?:number, win?:number, align?:boolean, dir?:string}} o
 * @returns {{master, win, items:Array<{id,delta,lagSeconds,confidence,startMs}>}}
 */
export async function computeTimerSync(o) {
  const ids = o.ids;
  const pos = o.pos != null ? o.pos : 600;
  const win = o.win != null ? o.win : 42;
  const align = o.align !== false;
  const ownDir = !o.dir;
  const dir = o.dir || mkdtempSync(join(tmpdir(), "ytds-timer-"));
  try {
    // Metadatos (hora de inicio) y descargas de video EN PARALELO (mismo instante
    // de pared en directo).
    const [metas, mp4s] = await Promise.all([
      align ? Promise.all(ids.map((id) => fetchMetaAsync(id))) : Promise.resolve(ids.map(() => null)),
      Promise.all(ids.map((id) => downloadVideoSectionAsync(id, pos, win, dir))),
    ]);
    const startMaster = metas[0] && metas[0].startMs;
    const frames = await Promise.all(mp4s.map(async (mp4) => toCenteredFrames(await extractStripRaw(mp4))));
    const master = frames[0];

    const items = [];
    for (let i = 1; i < ids.length; i++) {
      const { lagSeconds, confidence, score } = correlate(master, frames[i]);
      const shift = align && startMaster && metas[i] && metas[i].startMs
        ? (metas[i].startMs - startMaster) / 1000 : 0;
      items.push({
        id: ids[i],
        delta: shift - lagSeconds, // cuando el master está en t, el video i va en t − delta
        lagSeconds,
        confidence,
        score,
        startMs: metas[i] ? metas[i].startMs : null,
      });
    }
    return { master: ids[0], win, startMs: startMaster || null, items };
  } finally {
    if (ownDir) try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
