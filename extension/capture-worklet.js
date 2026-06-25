// AudioWorkletProcessor que acumula las muestras del canal 0 y las envía al
// offscreen en lotes. Reemplaza al ScriptProcessorNode (deprecado) sin bloquear
// el hilo principal. Avisa "started" en el primer bloque de audio real para que
// el offscreen ancle el reloj de pared con precisión.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._count = 0;
    this._flushAt = 8192; // ~0.17 s a 48 kHz
    this._started = false;
    this.port.onmessage = (e) => {
      if (e.data === "flush") this._flush();
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      if (!this._started) {
        this._started = true;
        this.port.postMessage("started");
      }
      this._buf.push(ch.slice(0));
      this._count += ch.length;
      if (this._count >= this._flushAt) this._flush();
    }
    return true; // mantener vivo el procesador
  }

  _flush() {
    if (!this._count) return;
    const out = new Float32Array(this._count);
    let o = 0;
    for (const c of this._buf) {
      out.set(c, o);
      o += c.length;
    }
    this.port.postMessage(out, [out.buffer]);
    this._buf = [];
    this._count = 0;
  }
}

registerProcessor("ytds-capture", CaptureProcessor);
