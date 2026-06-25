// Banco de pruebas: descarga audio de dos videos de YouTube y descubre el desfase
// por cross-correlación (mismo algoritmo que la extensión, reutilizado en Node).
//
// Uso:
//   node tools/sync-probe.mjs <urlA> <urlB> [--pos 600] [--win 120] [--rate 8000]
//   node tools/sync-probe.mjs <urlA> <urlB> --posA 600 --posB 560 --win 30
//
// delta = posA − posB − lagAudio  →  "cuánto va A por delante de B" (segundos).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateLag } from "../extension/lib/xcorr.js";
import { readWavMono } from "./wav.mjs";
import { ytId, downloadAudioSection, fetchMeta } from "./ytaudio.mjs";

function parseArgs(argv) {
  const pos = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) pos[a.slice(2)] = true; // flag
      else { pos[a.slice(2)] = next; i++; }
    } else pos._.push(a);
  }
  return pos;
}

export function probe({ idA, idB, posA, posB, win, rate, dir, quiet }) {
  const log = quiet ? () => {} : (...m) => console.error(...m);
  log(`↓ A ${idA} @${posA}s  ·  B ${idB} @${posB}s  (win ${win}s, ${rate}Hz)`);
  const wavA = downloadAudioSection(idA, posA, win, rate, dir);
  const wavB = downloadAudioSection(idB, posB, win, rate, dir);
  const A = readWavMono(wavA);
  const B = readWavMono(wavB);
  const sr = Math.min(A.sampleRate, B.sampleRate);
  const r = estimateLag(A.samples, B.samples, sr);
  // A_clip[i]=content(posA+i), B_clip[k]=content(posB+k); B lags A por lagSeconds
  // ⇒ contenido común cumple (posA−lag) ↔ posB ⇒ delta = posA − posB − lag.
  const delta = posA - posB - r.lagSeconds;
  return {
    idA, idB, posA, posB, win, rate,
    lagSeconds: r.lagSeconds,
    confidence: r.confidence,
    delta,
    samplesA: A.samples.length,
    samplesB: B.samples.length,
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a._.length < 2) {
    console.error("uso: node tools/sync-probe.mjs <urlA> <urlB> [--pos 600] [--win 120] [--rate 8000] [--posA n --posB n] [--align]");
    process.exit(1);
  }
  const idA = ytId(a._[0]);
  const idB = ytId(a._[1]);
  const win = parseFloat(a.win || "120");
  const rate = parseInt(a.rate || "8000", 10);
  let posA = a.posA != null ? parseFloat(a.posA) : parseFloat(a.pos || "600");
  let posB = a.posB != null ? parseFloat(a.posB) : parseFloat(a.pos || "600");

  // --align: usa la hora de inicio del directo para pre-alinear posB respecto a posA.
  if (a.align != null) {
    const mA = fetchMeta(idA);
    const mB = fetchMeta(idB);
    if (mA.startMs && mB.startMs) {
      const startDeltaSec = (mB.startMs - mA.startMs) / 1000; // B empezó esto después
      posB = posA - startDeltaSec; // misma franja de evento, ventana corta basta
      console.error(`align: startΔ=${startDeltaSec.toFixed(1)}s → posB=${posB.toFixed(1)}s`);
    } else {
      console.error("align: sin hora de inicio en uno de los dos; usando posiciones dadas");
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "ytds-probe-"));
  try {
    const out = probe({ idA, idB, posA, posB, win, rate, dir });
    console.log(JSON.stringify(out, null, 2));
    const verdict = out.confidence >= 0.25 ? "✓ coincide" : out.confidence >= 0.12 ? "~ dudoso" : "✗ no coincide";
    console.error(`\n${verdict} · Δ ${out.delta.toFixed(2)}s · conf ${out.confidence.toFixed(3)} · lag ${out.lagSeconds.toFixed(2)}s`);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
