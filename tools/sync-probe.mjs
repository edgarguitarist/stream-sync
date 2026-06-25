// Banco de pruebas: descarga audio de dos videos de YouTube y descubre el desfase
// por cross-correlación (mismo algoritmo que la extensión, reutilizado en Node).
//
// Uso:
//   node tools/sync-probe.mjs <urlA> <urlB> [--pos 600] [--win 120] [--rate 8000]
//   node tools/sync-probe.mjs <urlA> <urlB> --posA 600 --posB 560 --win 30
//
// delta = posA − posB − lagAudio  →  "cuánto va A por delante de B" (segundos).
import { fileURLToPath } from "node:url";
import { ytId } from "./ytaudio.mjs";
import { computeSync } from "./sync.mjs";

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

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a._.length < 2) {
    console.error("uso: node tools/sync-probe.mjs <urlA> <urlB> [--pos 600] [--win 30] [--rate 8000] [--posA n --posB n] [--no-align]");
    process.exit(1);
  }
  const out = computeSync({
    idA: ytId(a._[0]),
    idB: ytId(a._[1]),
    pos: parseFloat(a.pos || "600"),
    win: parseFloat(a.win || "30"),
    rate: parseInt(a.rate || "8000", 10),
    posA: a.posA != null ? parseFloat(a.posA) : undefined,
    posB: a.posB != null ? parseFloat(a.posB) : undefined,
    align: a["no-align"] == null, // alineación por hora de inicio ON salvo --no-align
  });
  console.log(JSON.stringify(out, null, 2));
  const verdict = out.confidence >= 0.25 ? "✓ coincide" : out.confidence >= 0.12 ? "~ dudoso" : "✗ no coincide";
  console.error(`\n${verdict} · Δ ${out.delta.toFixed(2)}s · conf ${out.confidence.toFixed(3)} · lag ${out.lagSeconds.toFixed(2)}s`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
