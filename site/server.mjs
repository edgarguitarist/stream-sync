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
  let p;
  try {
    p = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch {
    return send(res, 400, "bad request"); // URL con %-encoding malformado
  }
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
  let aborted = false;
  const sendJson = (code, payload) => send(res, code, JSON.stringify(payload), MIME[".json"]);

  req.on("data", (c) => {
    if (aborted) return;
    body += c;
    if (body.length > 1e6) {
      aborted = true;
      sendJson(413, { error: "cuerpo demasiado grande" });
      req.destroy();
    }
  });
  req.on("end", () => {
    if (aborted) return;
    let data;
    try { data = JSON.parse(body); } catch {
      return sendJson(400, { error: "JSON inválido" });
    }
    // Acepta {urls:[...]} (N videos) o {urlA,urlB} (compatibilidad).
    const urls = Array.isArray(data.urls) && data.urls.length
      ? data.urls
      : [data.urlA, data.urlB];
    const ids = urls.map((u) => ytId(u || ""));
    if (ids.length < 2 || ids.some((id) => !/^[\w-]{11}$/.test(id))) {
      return sendJson(400, { error: "Hace falta al menos 2 URLs de YouTube válidas" });
    }
    // Trabajo pesado (descarga + FFT) en un proceso hijo: no bloquea el servidor.
    const child = spawn("node", [JOB, ids.join(","), String(Number(data.pos) || 600), String(Number(data.win) || 30)], {
      cwd: __dir,
    });
    let out = "", err = "", done = false;
    const finish = (code, raw, type) => {
      if (done) return;
      done = true;
      send(res, code, raw, type);
    };
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) =>
      finish(500, JSON.stringify({ error: "no se pudo lanzar el cálculo: " + String((e && e.message) || e) }), MIME[".json"])
    );
    child.on("close", () => {
      if (!out.trim()) {
        return finish(500, JSON.stringify({ error: "el cálculo no devolvió datos: " + err.slice(-200) }), MIME[".json"]);
      }
      finish(200, out, MIME[".json"]);
    });
    // Si el cliente se desconecta, matamos el hijo y no escribimos en el socket cerrado.
    res.on("close", () => {
      if (!res.writableEnded) {
        done = true;
        child.kill("SIGKILL");
      }
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
