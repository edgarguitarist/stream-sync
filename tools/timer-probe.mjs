// CLI: sync por timer (correlación visual de la franja) de N videos.
//   node tools/timer-probe.mjs <url1> <url2> [url3...] [--win 42] [--pos 600]
// Imprime, por video seguidor, su delta, lag y confianza (pico/media).
import { ytId } from "./ytaudio.mjs";
import { computeTimerSync } from "./timersync.mjs";

function flag(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// URLs = args posicionales (descarta cada --flag y el valor que le sigue).
const argv = process.argv.slice(2);
const urls = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) { i++; continue; }
  urls.push(argv[i]);
}
const ids = urls.map(ytId);
if (ids.length < 2 || ids.some((id) => !/^[\w-]{11}$/.test(id))) {
  console.error("uso: timer-probe <url1> <url2> [url3...] [--win 42] [--pos 600]");
  process.exit(1);
}

const win = Number(flag("win", 42));
const pos = Number(flag("pos", 600));

console.error(`Sync por timer de ${ids.length} videos (win=${win}s)…`);
const t0 = Date.now();
const res = await computeTimerSync({ ids, win, pos });
console.error(`\nReferencia: ${res.master}`);
for (const it of res.items) {
  const tag = it.confidence >= 6 ? "✓ fiable" : it.confidence >= 3 ? "~ dudoso" : "✗ sin señal";
  console.error(`  ${it.id}: Δ=${it.delta.toFixed(2)}s  lag=${it.lagSeconds.toFixed(2)}s  ` +
    `conf=${it.confidence.toFixed(1)} (${tag})`);
}
console.error(`\n(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log(JSON.stringify(res));
