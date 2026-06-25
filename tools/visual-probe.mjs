// CLI del sync por imagen. Igual que sync-probe pero correlacionando actividad
// visual en vez de audio.
//   node tools/visual-probe.mjs <urlA> <urlB> [--pos 600] [--win 60] [--align]
import { fileURLToPath } from "node:url";
import { ytId } from "./ytaudio.mjs";
import { computeVisualSync } from "./visual.mjs";

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) o[a.slice(2)] = true;
      else { o[a.slice(2)] = next; i++; }
    } else o._.push(a);
  }
  return o;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a._.length < 2) {
    console.error("uso: node tools/visual-probe.mjs <urlA> <urlB> [--pos 600] [--win 60] [--posA n --posB n] [--no-align]");
    process.exit(1);
  }
  const out = computeVisualSync({
    idA: ytId(a._[0]),
    idB: ytId(a._[1]),
    pos: parseFloat(a.pos || "600"),
    win: parseFloat(a.win || "60"),
    posA: a.posA != null ? parseFloat(a.posA) : undefined,
    posB: a.posB != null ? parseFloat(a.posB) : undefined,
    align: a["no-align"] == null,
  });
  console.log(JSON.stringify(out, null, 2));
  const verdict = out.confidence >= 0.2 ? "✓ actividad coincide" : out.confidence >= 0.1 ? "~ dudoso" : "✗ no coincide";
  console.error(`\n${verdict} · Δ ${out.delta.toFixed(2)}s · conf ${out.confidence.toFixed(3)} · lag ${out.lagSeconds.toFixed(2)}s`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
