// Cross-correlación por FFT para descubrir el desfase entre dos señales de audio.
// Núcleo de la Fase 2: dadas dos capturas del audio compartido, estima cuántos
// segundos va una respecto a la otra. Sin dependencias; corre en el navegador
// (offscreen document) y en Node (tests).

/** Siguiente potencia de 2 >= n. */
export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / (arr.length || 1);
}

/**
 * FFT iterativa radix-2 in-place (Cooley-Tukey). `re`/`im` tienen longitud
 * potencia de 2. `inverse=true` calcula la IFFT (con normalización 1/n).
 */
export function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < half; k++) {
        const idx = i + k, jdx = i + k + half;
        const vr = re[jdx] * cwr - im[jdx] * cwi;
        const vi = re[jdx] * cwi + im[jdx] * cwr;
        re[jdx] = re[idx] - vr; im[jdx] = im[idx] - vi;
        re[idx] += vr; im[idx] += vi;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = ncwr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

/**
 * Estima el desfase entre `a` y `b` (arrays de muestras a la misma tasa).
 *
 * Convención: lagSeconds > 0 significa que `b` va RETRASADA respecto a `a`
 * (el contenido de `a` aparece en `b` lagSeconds después). Para alinearlas,
 * habría que adelantar `b` o retrasar `a` en esa cantidad.
 *
 * @returns {{lagSamples:number, lagSeconds:number, confidence:number}}
 *   confidence = pico / media de |correlación|; valores altos (≫ 1) indican
 *   un desfase claro; cercano a 1 ≈ ruido, no fiable.
 */
export function estimateLag(a, b, sampleRate) {
  const n = nextPow2(a.length + b.length);
  const ar = new Float64Array(n), ai = new Float64Array(n);
  const br = new Float64Array(n), bi = new Float64Array(n);
  const am = mean(a), bm = mean(b);
  for (let i = 0; i < a.length; i++) ar[i] = a[i] - am;
  for (let i = 0; i < b.length; i++) br[i] = b[i] - bm;

  fft(ar, ai, false);
  fft(br, bi, false);

  // Producto cruzado A · conj(B).
  const cr = new Float64Array(n), ci = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    cr[i] = ar[i] * br[i] + ai[i] * bi[i];
    ci[i] = ai[i] * br[i] - ar[i] * bi[i];
  }
  fft(cr, ci, true); // IFFT → correlación cruzada (parte real)

  let peak = -Infinity, idx = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(cr[i]);
    if (v > peak) { peak = v; idx = i; }
  }

  // Confianza = coeficiente de correlación normalizado en el pico (∈ [0, 1]):
  // pico / sqrt(energía(a) · energía(b)). Cercano a 1 = audio compartido claro;
  // cercano a 0 = señales no relacionadas. Es invariante a la escala/volumen y
  // no se deja engañar por el sesgo triangular del zero-padding.
  let ea = 0, eb = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - am; ea += d * d; }
  for (let i = 0; i < b.length; i++) { const d = b[i] - bm; eb += d * d; }
  const confidence = peak / (Math.sqrt(ea * eb) || 1e-9);

  // Índices en la segunda mitad representan desfases negativos. Negamos para
  // que lagSeconds > 0 signifique que `b` va RETRASADA respecto a `a`.
  const raw = idx <= n / 2 ? idx : idx - n;
  const lag = -raw;
  return { lagSamples: lag, lagSeconds: lag / sampleRate, confidence };
}
