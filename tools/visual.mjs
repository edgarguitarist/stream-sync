// Sync por imagen (prototipo). Descarga un trozo de video de baja resolución de
// cada fuente, extrae una "señal de actividad visual" (diferencia media entre
// frames consecutivos) con ffmpeg, y cross-correlaciona ambas señales en el
// tiempo con el mismo estimateLag del audio. Útil cuando los POV comparten vista
// o eventos visuales sincronizados (transiciones, caídas, etc.).
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateLag } from "../extension/lib/xcorr.js";
import { fetchMeta } from "./ytaudio.mjs";

const FPS = 5; // muestras/seg de la señal de actividad
const W = 32, H = 18; // miniatura gris para medir actividad

/** Descarga [start, start+dur] s de video de baja resolución (mp4). */
function downloadVideoSection(id, start, dur, outDir, attempts = 3) {
  const base = join(outDir, `${id}_${Math.round(start)}_${Math.round(dur)}`);
  const mp4 = `${base}.mp4`;
  if (existsSync(mp4)) return mp4;
  const args = ["-m", "yt_dlp", "-q", "--no-warnings",
    "-f", "bv*[height<=240]/wv*[height<=360]/worstvideo",
    "--download-sections", `*${start}-${start + dur}`,
    "--force-keyframes-at-cuts",
    "--recode-video", "mp4",
    "-o", `${base}.%(ext)s`,
    `https://www.youtube.com/watch?v=${id}`];
  let last = "";
  for (let i = 0; i < attempts; i++) {
    const r = spawnSync("python", args, { encoding: "utf8", timeout: 240000 });
    if (existsSync(mp4)) return mp4;
    last = r.stderr || r.stdout || String(r.error);
  }
  throw new Error(`descarga de video falló (${id}): ${last.slice(-200)}`);
}

/** Señal de actividad: diferencia media entre frames gris consecutivos (a FPS). */
function activitySignal(mp4) {
  const r = spawnSync("ffmpeg", [
    "-i", mp4,
    "-vf", `fps=${FPS},scale=${W}:${H},format=gray`,
    "-f", "rawvideo", "-",
  ], { maxBuffer: 256 * 1024 * 1024, encoding: "buffer" });
  if (!r.stdout || !r.stdout.length) throw new Error("ffmpeg no produjo frames: " + (r.stderr || ""));
  const frameSize = W * H;
  const n = Math.floor(r.stdout.length / frameSize);
  const act = new Float32Array(Math.max(0, n - 1));
  for (let f = 1; f < n; f++) {
    let s = 0;
    const o0 = (f - 1) * frameSize, o1 = f * frameSize;
    for (let i = 0; i < frameSize; i++) s += Math.abs(r.stdout[o1 + i] - r.stdout[o0 + i]);
    act[f - 1] = s / frameSize;
  }
  return act;
}

/** Calcula el desfase visual entre dos videos. delta = posA − posB − lag. */
export function computeVisualSync(o) {
  const { idA, idB } = o;
  const pos = o.pos != null ? o.pos : 600;
  const win = o.win != null ? o.win : 60;
  const align = o.align !== false;
  const ownDir = !o.dir;
  const dir = o.dir || mkdtempSync(join(tmpdir(), "ytds-vis-"));
  try {
    let posA = o.posA != null ? o.posA : pos;
    let posB = o.posB != null ? o.posB : pos;
    let metaA = null, metaB = null;
    if (o.posA == null && o.posB == null && align) {
      metaA = fetchMeta(idA);
      metaB = fetchMeta(idB);
      if (metaA.startMs && metaB.startMs) posB = posA - (metaB.startMs - metaA.startMs) / 1000;
    }
    const shift = Math.min(0, posA, posB);
    posA -= shift;
    posB -= shift;

    const actA = activitySignal(downloadVideoSection(idA, posA, win, dir));
    const actB = activitySignal(downloadVideoSection(idB, posB, win, dir));
    const r = estimateLag(actA, actB, FPS);
    const delta = posA - posB - r.lagSeconds;
    return {
      idA, idB, posA, posB, win, fps: FPS,
      lagSeconds: r.lagSeconds, confidence: r.confidence, delta,
      framesA: actA.length, framesB: actB.length,
    };
  } finally {
    if (ownDir) try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}
