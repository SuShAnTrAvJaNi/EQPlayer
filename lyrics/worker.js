/* EQ Player - Tier 3 lyrics worker (module worker).
 * Runs Whisper through Transformers.js entirely off the main thread.
 * Messages in:   { type:'init', id, model, device, transformersUrl }
 *                { type:'chunk', id, pcm: Float32Array (16 kHz mono, <= 30 s), offset (s), multilingual, language }
 * Messages out:  { type:'progress', id, p (0..1) } | { type:'ready', id } |
 *                { type:'segments', id, segs:[{t, text}] } | { type:'error', id, message }
 */
let pipe = null;

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const { pipeline, env } = await import(m.transformersUrl);
      env.allowLocalModels = false;
      pipe = await pipeline('automatic-speech-recognition', m.model, {
        device: m.device,
        dtype: 'q8',
        progress_callback: (info) => {
          if (info && typeof info.progress === 'number') {
            self.postMessage({ type: 'progress', id: m.id, p: info.progress / 100 });
          }
        }
      });
      self.postMessage({ type: 'ready', id: m.id });
      return;
    }
    if (m.type === 'chunk') {
      if (!pipe) throw new Error('The speech model is not loaded.');
      const opts = { return_timestamps: true };
      if (m.multilingual) { if (m.language) opts.language = m.language; opts.task = 'transcribe'; }   // no language: Whisper auto-detects
      const out = await pipe(m.pcm, opts);
      const segs = (out.chunks || []).map((c) => ({
        t: m.offset + (c.timestamp && c.timestamp[0] ? c.timestamp[0] : 0),
        text: c.text || ''
      }));
      self.postMessage({ type: 'segments', id: m.id, segs });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
