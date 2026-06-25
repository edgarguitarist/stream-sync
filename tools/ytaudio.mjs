// Descarga de audio de YouTube por secciones, vía yt-dlp + ffmpeg. Reutilizado
// por el banco de pruebas (sync-probe) y por el backend del sitio.
// Hay versiones síncronas (spawnSync) y asíncronas (spawn) — las async permiten
// descargar varios videos EN PARALELO con Promise.all.
import { spawnSync, spawn } from "node:child_process";
import { existsSync, rmSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

/** Borra cualquier resto de descarga (.part, intermedios .webm/.m4a, etc.) por prefijo. */
export function cleanPartials(outDir, prefix) {
  try {
    for (const f of readdirSync(outDir)) {
      if (f.startsWith(prefix)) {
        try { rmSync(join(outDir, f), { force: true }); } catch (_) {}
      }
    }
  } catch (_) {}
}

/** Extrae el id de 11 caracteres de una URL de YouTube (o lo devuelve tal cual). */
export function ytId(s) {
  const str = String(s).trim();
  const m = str.match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/|\/embed\/)([\w-]{11})/);
  if (m) return m[1];
  if (/^[\w-]{11}$/.test(str)) return str;
  return str;
}

/** Comando base de yt-dlp (módulo de Python). */
function ytdlpArgs(rest) {
  return ["-m", "yt_dlp", ...rest];
}

function audioArgs(id, start, dur, rate, base) {
  return ytdlpArgs([
    "-q", "--no-warnings",
    "-x", "--audio-format", "wav",
    "--postprocessor-args", `-ar ${rate} -ac 1`,
    "--download-sections", `*${start}-${start + dur}`,
    "--force-keyframes-at-cuts",
    "-o", `${base}.%(ext)s`,
    `https://www.youtube.com/watch?v=${id}`,
  ]);
}

function metaArgs(id) {
  return ytdlpArgs([
    "-q", "--no-warnings", "--skip-download",
    "--print", "%(release_timestamp)s|%(timestamp)s|%(duration)s",
    `https://www.youtube.com/watch?v=${id}`,
  ]);
}

function parseMeta(stdout) {
  const line = (stdout || "").trim().split("\n").pop() || "";
  const [rel, ts, dur] = line.split("|");
  const epoch = parseInt(rel, 10) || parseInt(ts, 10) || null;
  return { startMs: epoch ? epoch * 1000 : null, duration: parseFloat(dur) || null };
}

// --- Versiones SÍNCRONAS (usadas por el pipeline de imagen) -----------------

/** Descarga [start, start+dur] s de audio como WAV mono a `rate` Hz. Devuelve la ruta. */
export function downloadAudioSection(id, start, dur, rate, outDir, attempts = 3) {
  const base = join(outDir, `${id}_${Math.round(start)}_${Math.round(dur)}`);
  const wav = `${base}.wav`;
  if (existsSync(wav)) return wav;
  const args = audioArgs(id, start, dur, rate, base);
  let last = "";
  for (let i = 0; i < attempts; i++) {
    const r = spawnSync("python", args, { encoding: "utf8", timeout: 240000 });
    if (existsSync(wav)) return wav;
    last = r.stderr || r.stdout || String(r.error) || "sin salida";
    cleanPartials(outDir, basename(base));
  }
  throw new Error(`descarga falló (${id}) tras ${attempts} intentos: ${last.slice(-300)}`);
}

/** Metadatos para pre-alinear: { startMs|null, duration|null }. */
export function fetchMeta(id) {
  const r = spawnSync("python", metaArgs(id), { encoding: "utf8", timeout: 60000 });
  return parseMeta(r.stdout);
}

// --- Versiones ASÍNCRONAS (para descargar en paralelo) ----------------------

/** Como downloadAudioSection pero asíncrona (Promise) → permite Promise.all. */
export function downloadAudioSectionAsync(id, start, dur, rate, outDir, attempts = 3) {
  const base = join(outDir, `${id}_${Math.round(start)}_${Math.round(dur)}`);
  const wav = `${base}.wav`;
  if (existsSync(wav)) return Promise.resolve(wav);
  const args = audioArgs(id, start, dur, rate, base);

  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryOnce = () => {
      attempt++;
      const child = spawn("python", args, { timeout: 240000 });
      let err = "", settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (existsSync(wav)) return resolve(wav);
        cleanPartials(outDir, basename(base));
        if (attempt < attempts) return tryOnce();
        reject(new Error(`descarga falló (${id}) tras ${attempts} intentos: ${err.slice(-300) || "sin salida"}`));
      };
      child.stderr.on("data", (c) => (err += c));
      child.on("error", (e) => { err += " " + String((e && e.message) || e); done(); });
      child.on("close", done);
    };
    tryOnce();
  });
}

/** Como fetchMeta pero asíncrona (Promise). Nunca rechaza: devuelve nulos si falla. */
export function fetchMetaAsync(id) {
  return new Promise((resolve) => {
    const child = spawn("python", metaArgs(id), { timeout: 60000 });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", () => resolve({ startMs: null, duration: null }));
    child.on("close", () => resolve(parseMeta(out)));
  });
}
