// Backend del sitio YT Dual Sync.
// Sirve la página y expone POST /api/sync, que calcula el desfase por audio
// SERVER-SIDE (yt-dlp descarga los audios → sin el muro CORS del navegador) y lo
// devuelve para que la página embeba ambos videos ya sincronizados.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize, sep } from "node:path";
import { ytId } from "../tools/ytaudio.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const PUB = join(__dir, "public");
const JOB = join(__dir, "syncjob.mjs");
const PORT = process.env.PORT || 5178;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type });
  res.end(body);
}

async function serveStatic(req, res) {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  const full = normalize(join(PUB, p));
  if (full !== PUB && !full.startsWith(PUB + sep)) return send(res, 403, "forbidden");
  try {
    const buf = await readFile(full);
    send(res, 200, buf, MIME[extname(full)] || "application/octet-stream");
  } catch {
    send(res, 404, "not found");
  }
}

function handleSync(req, res) {
  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 1e6) req.destroy();
  });
  req.on("end", () => {
    let data;
    try { data = JSON.parse(body); } catch {
      return send(res, 400, JSON.stringify({ error: "JSON inválido" }), MIME[".json"]);
    }
    const idA = ytId(data.urlA || "");
    const idB = ytId(data.urlB || "");
    if (!/^[\w-]{11}$/.test(idA) || !/^[\w-]{11}$/.test(idB)) {
      return send(res, 400, JSON.stringify({ error: "URLs de YouTube inválidas" }), MIME[".json"]);
    }
    // Trabajo pesado (descarga + FFT) en un proceso hijo: no bloquea el servidor.
    const child = spawn("node", [JOB, idA, idB, String(Number(data.pos) || 600), String(Number(data.win) || 30)], {
      cwd: __dir,
    });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", () => {
      if (!out.trim()) {
        return send(res, 500, JSON.stringify({ error: "el cálculo no devolvió datos: " + err.slice(-200) }), MIME[".json"]);
      }
      send(res, 200, out, MIME[".json"]);
    });
  });
}

const server = createServer((req, res) => {
  if (req.method === "POST" && (req.url || "").split("?")[0] === "/api/sync") {
    return handleSync(req, res);
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`YT Dual Sync → http://localhost:${PORT}`);
});
