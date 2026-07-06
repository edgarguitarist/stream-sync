// Orquestador de fusión multi-fuente. Para cada video seguidor combina, por
// orden de preferencia, tres estimaciones del desfase contra la referencia:
//
//   1. TIMER  (correlación visual de la franja) — la mejor cuando hay un reloj
//      de juego visible; exacto al segundo. Falla si no hay timer en pantalla.
//   2. AUDIO  (cross-correlación) — sirve cuando los POV comparten audio claro;
//      ruidoso (confianza baja) si la señal compartida es débil.
//   3. INICIO (hora de arranque del directo) — siempre disponible, pero no
//      corrige la latencia de transmisión.
//
// Audio y timer corren EN PARALELO. Se elige la primera fuente cuya confianza
// supere su umbral; si ninguna lo hace, se cae a la hora de inicio y se marca
// baja confianza para que el sitio invite al ajuste manual.
import { computeMulti } from "./sync.mjs";
import { computeTimerSync } from "./timersync.mjs";

const AUDIO_OK = 0.25; // coef. de correlación normalizado mínimo del audio
const TIMER_OK = 6;    // pico/media mínimo de la correlación del timer

/** Promesa con tope de tiempo: resuelve a `fallback` si `p` tarda demasiado. */
function withTimeout(p, ms, fallback) {
  return Promise.race([
    p.catch(() => fallback),
    new Promise((res) => setTimeout(() => res(fallback), ms)),
  ]);
}

export async function computeFused(o) {
  const ids = o.ids;
  const pos = o.pos != null ? o.pos : 600;
  // SECUENCIAL, no en paralelo: en directo, lanzar audio (3 descargas) y timer
  // (otras 3) a la vez satura la red del live y caen todas. Primero el audio
  // (ligero, resultado garantizado); luego el timer, que refina si trae señal.
  const audio = await withTimeout(computeMulti({ ids, pos, win: o.winAudio != null ? o.winAudio : 30 }), 120000, null);
  const timer = await withTimeout(computeTimerSync({ ids, pos, win: o.winTimer != null ? o.winTimer : 35 }), 100000, null);
  if (!audio && !timer) throw new Error("no se pudo calcular el desfase (audio y timer fallaron)");

  const base = audio || timer;
  const aMap = new Map((audio ? audio.items : []).map((it) => [it.id, it]));
  const tMap = new Map((timer ? timer.items : []).map((it) => [it.id, it]));

  const items = ids.slice(1).map((id) => {
    const a = aMap.get(id);
    const t = tMap.get(id);
    // shift (hora de inicio) recuperado de cualquier fuente: delta = shift − lag.
    const shift = a ? a.delta + a.lagSeconds : (t ? t.delta + t.lagSeconds : 0);

    let chosen;
    if (t && t.confidence >= TIMER_OK) {
      chosen = { delta: t.delta, source: "timer", confidence: t.confidence, lagSeconds: t.lagSeconds };
    } else if (a && a.confidence >= AUDIO_OK) {
      chosen = { delta: a.delta, source: "audio", confidence: a.confidence, lagSeconds: a.lagSeconds };
    } else {
      chosen = { delta: shift, source: "startTime", confidence: 0, lagSeconds: 0 };
    }
    return {
      id,
      ...chosen,
      startMs: (a && a.startMs) || (t && t.startMs) || null,
      // Desgloses para que el sitio muestre/permita elegir la fuente.
      audio: a ? { delta: a.delta, confidence: a.confidence } : null,
      timer: t ? { delta: t.delta, confidence: t.confidence } : null,
    };
  });

  return {
    master: base.master,
    posMaster: audio ? audio.posMaster : pos,
    win: audio ? audio.win : (timer ? timer.win : null),
    startMs: base.startMs || null,
    duration: audio ? audio.duration : null,
    items,
  };
}
