// Test del núcleo de cross-correlación. Ejecutar: node extension/lib/xcorr.test.mjs
import { estimateLag } from "./xcorr.js";

let fail = 0;
function check(name, cond, extra) {
  console.log((cond ? "OK   " : "FAIL ") + name + (extra ? "  " + extra : ""));
  if (!cond) fail++;
}

const SR = 16000; // 16 kHz

// mulberry32: PRNG de 32 bits con Math.imul (sin overflow de doble precisión).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

// Ruido de banda ancha: modela el audio ambiente/voz compartido por ambos POV
// mejor que un tono puro (su autocorrelación tiene un pico único y claro).
function broadband(len, seed) {
  const r = rng(seed);
  const x = new Float64Array(len);
  for (let i = 0; i < len; i++) x[i] = r(i);
  return x;
}

// Mezcla: base (retrasada D) + ruido propio del stream (lo que difiere entre POV).
function streamFrom(base, D, noiseSeed, noiseAmp) {
  const r = rng(noiseSeed);
  const out = new Float64Array(base.length);
  for (let i = 0; i < base.length; i++) {
    const src = i - D >= 0 && i - D < base.length ? base[i - D] : 0;
    out[i] = src + noiseAmp * r(i);
  }
  return out;
}

const N = 1 << 14; // 16384 muestras ≈ 1.02 s
const base = broadband(N, 7);

// 1) Audio compartido con b retrasada D=320 (20 ms) + ruido propio de cada POV.
{
  const D = 320;
  const a = streamFrom(base, 0, 101, 0.3);
  const b = streamFrom(base, D, 202, 0.3);
  const r = estimateLag(a, b, SR);
  check("recupera D=320 (±1)", Math.abs(r.lagSamples - D) <= 1, `lag=${r.lagSamples}, conf=${r.confidence.toFixed(3)}`);
  check("confianza alta (>0.5)", r.confidence > 0.5, `conf=${r.confidence.toFixed(3)}`);
  check("lagSeconds ≈ 0.02s", Math.abs(r.lagSeconds - 0.02) < 0.001, `${r.lagSeconds.toFixed(4)}s`);
}

// 2) Desfase negativo: si invertimos argumentos, el signo se invierte.
{
  const D = 512;
  const a = streamFrom(base, 0, 11, 0.3);
  const b = streamFrom(base, D, 22, 0.3);
  const r = estimateLag(b, a, SR); // argumentos invertidos → lag negativo
  check("signo se invierte al invertir args", Math.abs(r.lagSamples + D) <= 1, `lag=${r.lagSamples}`);
}

// 3) Sin audio compartido (dos fuentes independientes): confianza baja → no
//    debe reportar un sync falso.
{
  const x = broadband(N, 33);
  const y = broadband(N, 9001);
  const r = estimateLag(x, y, SR);
  check("no correlacionado → confianza baja (<0.1)", r.confidence < 0.1, `conf=${r.confidence.toFixed(3)}`);
}

console.log(fail ? `\n${fail} fallo(s)` : "\nTodos los casos OK");
process.exit(fail ? 1 : 0);
