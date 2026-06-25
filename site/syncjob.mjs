// Proceso hijo: calcula el desfase de N videos contra el primero y lo imprime
// como JSON. Lo lanza el servidor con spawn (asíncrono) para no bloquear su
// event loop ni morir si yt-dlp falla.
import { computeMulti } from "../tools/sync.mjs";

const [, , idsArg, pos, win] = process.argv;
const ids = (idsArg || "").split(",").filter(Boolean);
try {
  const out = await computeMulti({ ids, pos: Number(pos) || 600, win: Number(win) || 30 });
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) }));
}
