// Proceso hijo: calcula el desfase y lo imprime como JSON. Lo lanza el servidor
// con spawn (asíncrono) para no bloquear su event loop ni morir si yt-dlp falla.
import { computeSync } from "../tools/sync.mjs";

const [, , idA, idB, pos, win] = process.argv;
try {
  const out = computeSync({ idA, idB, pos: Number(pos) || 600, win: Number(win) || 30 });
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) }));
}
