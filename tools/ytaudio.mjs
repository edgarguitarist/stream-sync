// Descarga de audio de YouTube por secciones, vía yt-dlp + ffmpeg. Reutilizado
// por el banco de pruebas (sync-probe) y por el backend del sitio.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Extrae el id de 11 caracteres de una URL de YouTube (o lo devuelve tal cual). */
export function ytId(s) {
  const str = String(s).trim();
  const m = str.match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/|\/embed\/)([\w-]{11})/);
  if (m) return m[1];
  if (/^[\w-]{11}$/.test(str)) return str;
  return str;
}

/** Comando base de yt-dlp (binario o módulo de Python). */
function ytdlpArgs(rest) {
  return ["-m", "yt_dlp", ...rest];
}

/**
 * Descarga [start, start+dur] segundos de audio como WAV mono a `rate` Hz.
 * Devuelve la ruta del .wav. Lanza si falla.
 */
export function downloadAudioSection(id, start, dur, rate, outDir, attempts = 3) {
  const base = join(outDir, `${id}_${Math.round(start)}_${Math.round(dur)}`);
  const wav = `${base}.wav`;
  if (existsSync(wav)) return wav; // cache simple
  const section = `*${start}-${start + dur}`;
  const args = ytdlpArgs([
    "-q", "--no-warnings",
    "-x", "--audio-format", "wav",
    "--postprocessor-args", `-ar ${rate} -ac 1`,
    "--download-sections", section,
    "--force-keyframes-at-cuts",
    "-o", `${base}.%(ext)s`,
    `https://www.youtube.com/watch?v=${id}`,
  ]);
  let last = "";
  for (let i = 0; i < attempts; i++) {
    const r = spawnSync("python", args, { encoding: "utf8", timeout: 240000 });
    if (existsSync(wav)) return wav;
    last = r.stderr || r.stdout || String(r.error) || "sin salida";
    try { rmSync(`${base}.part`, { force: true }); } catch (_) {}
  }
  throw new Error(`descarga falló (${id}) tras ${attempts} intentos: ${last.slice(-300)}`);
}

/**
 * Metadatos útiles para pre-alinear: epoch ms del inicio del directo (si aplica)
 * y duración. Devuelve { startMs|null, duration|null }.
 */
export function fetchMeta(id) {
  const args = ytdlpArgs([
    "-q", "--no-warnings", "--skip-download",
    "--print", "%(release_timestamp)s|%(timestamp)s|%(duration)s",
    `https://www.youtube.com/watch?v=${id}`,
  ]);
  const r = spawnSync("python", args, { encoding: "utf8", timeout: 60000 });
  const line = (r.stdout || "").trim().split("\n").pop() || "";
  const [rel, ts, dur] = line.split("|");
  const epoch = parseInt(rel, 10) || parseInt(ts, 10) || null;
  return {
    startMs: epoch ? epoch * 1000 : null,
    duration: parseFloat(dur) || null,
  };
}
