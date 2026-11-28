/* EQ Player - lyrics engine.
 * Pure logic with no DOM access, so it can be unit-tested in Node.
 *
 * Waterfall (each tier only runs if the one above found nothing):
 *   Tier 1  file tags: ID3 SYLT (synced) / USLT (plain), or a paired .lrc file
 *   Tier 2  LRCLIB lookup by title / artist / album / duration (cached in IndexedDB)
 *   Tier 3  optional Whisper transcription, run inside lyrics/worker.js (never on the main thread)
 */
(function (g) {
  'use strict';

  const CFG = g.EQP_CONFIG || {};
  const LRCLIB = String(CFG.VITE_LRCLIB_BASE || 'https://lrclib.net/api').replace(/\/+$/, '');
  const WORKER_URL = CFG.VITE_LYRICS_WORKER || 'lyrics/worker.js';
  const WHISPER_MODEL = CFG.VITE_WHISPER_MODEL || 'Xenova/whisper-tiny.en';
  const TRANSFORMERS_URL = CFG.VITE_TRANSFORMERS_URL || 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm';
  const CACHE_DB = 'eqplayer-lyrics';
  const CACHE_STORE = 'lrc';
  const MISS_TTL = 7 * 24 * 3600 * 1000;
  const FETCH_TIMEOUT = 8000;
  const MAX_AI_SECONDS = 20 * 60;
  const SAMPLE_RATE = 16000;
  const CHUNK_SECONDS = 30;

  const abortError = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };
  const throwIfAborted = (sig) => { if (sig && sig.aborted) throw abortError(); };
  const ok = (kind, lines, source) => ({ kind, lines, source });
  const none = () => ({ kind: 'none', lines: [], source: null });
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  /* ---------- LRC (synced) and plain text ---------- */
  function parseLrc(text) {
    const src = String(text || '');
    const off = src.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
    const shift = off ? (+off[1]) / 1000 : 0;
    const out = [];
    for (const raw of src.split(/\r\n|\n|\r/)) {
      const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
      const stamps = [];
      let m, last = 0;
      while ((m = re.exec(raw))) {
        const frac = m[3] ? (+m[3]) / Math.pow(10, m[3].length) : 0;
        stamps.push(+m[1] * 60 + +m[2] + frac);
        last = re.lastIndex;
      }
      if (!stamps.length) continue;                       // metadata lines like [ti:...] are skipped
      const txt = raw.slice(last).trim();
      for (const t of stamps) out.push({ t: Math.max(0, t + shift), text: txt });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  function parsePlain(text) {
    const arr = String(text || '').split(/\r\n|\n|\r/).map((s) => s.trim());
    while (arr.length && !arr[0]) arr.shift();
    while (arr.length && !arr[arr.length - 1]) arr.pop();
    return arr.map((s) => ({ t: null, text: s }));
  }

  /* ---------- ID3v2 SYLT / USLT (v2.2, v2.3, v2.4) ---------- */
  const u32 = (b, o) => ((b[o] * 16777216) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]);
  const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
  const ascii = (b, o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]); return s; };

  function unsync(b) {
    const out = new Uint8Array(b.length);
    let j = 0;
    for (let i = 0; i < b.length; i++) {
      out[j++] = b[i];
      if (b[i] === 0xff && b[i + 1] === 0x00) i++;
    }
    return out.subarray(0, j);
  }

  const termLen = (enc) => (enc === 1 || enc === 2 ? 2 : 1);

  function skipTerminated(d, p, enc) {
    if (termLen(enc) === 1) { while (p < d.length && d[p] !== 0) p++; return p + 1; }
    while (p + 1 < d.length && !(d[p] === 0 && d[p + 1] === 0)) p += 2;
    return p + 2;
  }

  function decodeText(bytes, enc) {
    let b = bytes;
    let label = 'iso-8859-1';
    if (enc === 1) {
      if (b[0] === 0xff && b[1] === 0xfe) { label = 'utf-16le'; b = b.subarray(2); }
      else if (b[0] === 0xfe && b[1] === 0xff) { label = 'utf-16be'; b = b.subarray(2); }
      else label = 'utf-16le';
    } else if (enc === 2) label = 'utf-16be';
    else if (enc === 3) label = 'utf-8';
    try { return new TextDecoder(label).decode(b).replace(/\u0000/g, ''); } catch (e) { return ''; }
  }

  function decodeUslt(d) {
    const enc = d[0];
    const p = skipTerminated(d, 4, enc);                  // enc (1) + language (3) + descriptor
    return decodeText(d.subarray(Math.min(p, d.length)), enc).trim();
  }

  // Merge syllable/word entries into lines. A newline inside an entry's text ends the current line.
  function sylToLines(entries) {
    const lines = [];
    let t0 = null, buf = '';
    const flush = () => {
      const s = buf.replace(/\s+/g, ' ').trim();
      if (s && t0 != null) lines.push({ t: t0, text: s });
      t0 = null; buf = '';
    };
    for (const e of entries) {
      e.text.split(/\r\n|\n|\r/).forEach((piece, i) => {
        if (i > 0) flush();
        if (piece) { if (t0 == null) t0 = e.t; buf += piece; }
      });
    }
    flush();
    return lines;
  }

  function decodeSylt(d) {
    const enc = d[0];
    const fmt = d[4];                                     // 1 = MPEG frames, 2 = milliseconds
    const type = d[5];                                    // 1 = lyrics
    if (type !== 1) return null;
    let p = skipTerminated(d, 6, enc);
    const tl = termLen(enc);
    const entries = [];
    while (p < d.length) {
      const start = p;
      if (tl === 1) { while (p < d.length && d[p] !== 0) p++; }
      else { while (p + 1 < d.length && !(d[p] === 0 && d[p + 1] === 0)) p += 2; }
      const text = decodeText(d.subarray(start, p), enc);
      p += tl;
      if (p + 4 > d.length) break;
      const ts = u32(d, p);
      p += 4;
      // MPEG-frame timestamps are approximated at 44.1 kHz / 1152 samples per frame (about 26 ms).
      entries.push({ t: fmt === 2 ? ts / 1000 : (ts * 1152) / 44100, text });
    }
    return entries.length ? sylToLines(entries) : null;
  }

  // Returns { synced: [{t,text}] | null, plain: string | null }. Accepts an ArrayBuffer or Uint8Array.
  function parseId3Lyrics(input) {
    const res = { synced: null, plain: null };
    const full = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (full.length < 10 || full[0] !== 0x49 || full[1] !== 0x44 || full[2] !== 0x33) return res;
    const ver = full[3], flags = full[5];
    if (ver < 2 || ver > 4) return res;
    const size = syncsafe(full, 6);
    let tag = full.subarray(10, Math.min(full.length, 10 + size));
    if ((flags & 0x80) && ver < 4) tag = unsync(tag);
    let pos = 0;
    if (ver >= 3 && (flags & 0x40)) pos = ver === 4 ? syncsafe(tag, 0) : u32(tag, 0) + 4;
    const hdr = ver === 2 ? 6 : 10;
    const idLen = ver === 2 ? 3 : 4;
    while (pos + hdr <= tag.length && tag[pos] !== 0) {
      const id = ascii(tag, pos, idLen);
      const fsize = ver === 2
        ? ((tag[pos + 3] << 16) | (tag[pos + 4] << 8) | tag[pos + 5])
        : ver === 4 ? syncsafe(tag, pos + 4) : u32(tag, pos + 4);
      const fl = ver >= 3 ? tag[pos + 9] : 0;
      pos += hdr;
      if (fsize <= 0 || pos + fsize > tag.length) break;
      let d = tag.subarray(pos, pos + fsize);
      pos += fsize;
      if (ver === 3 && (fl & 0xc0)) continue;             // compressed or encrypted
      if (ver === 4) {
        if (fl & 0x0c) continue;
        if (fl & 0x02) d = unsync(d);
        if (fl & 0x01) d = d.subarray(4);                  // data length indicator
      }
      if (!d.length) continue;
      try {
        if ((id === 'SYLT' || id === 'SLT') && !res.synced) res.synced = decodeSylt(d);
        else if ((id === 'USLT' || id === 'ULT') && !res.plain) res.plain = decodeUslt(d);
      } catch (e) { /* malformed frame: ignore it */ }
    }
    return res;
  }

  /* ---------- LRCLIB (Tier 2) ---------- */
  function qs(obj) {
    const p = new URLSearchParams();
    for (const k in obj) if (obj[k] != null && obj[k] !== '') p.set(k, String(obj[k]));
    return p.toString();
  }

  async function fetchJson(url, sig) {
    throwIfAborted(sig);
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (sig) sig.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctl.signal });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('LRCLIB HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
      if (sig) sig.removeEventListener('abort', onAbort);
    }
  }

  // Prefer a result whose duration is within 3 s of the file. Without a match we return nothing,
  // because lyrics for a different recording of the same title are worse than no lyrics.
  function pickBest(list, dur) {
    const usable = (list || []).filter((r) => r && (r.syncedLyrics || r.plainLyrics) && !r.instrumental);
    const pool = dur > 0 ? usable.filter((r) => Math.abs((r.duration || 0) - dur) <= 3) : usable;
    return pool.find((r) => r.syncedLyrics) || pool[0] || null;
  }

  async function lookupLrclib(meta, sig) {
    // "Song - 2012 Remaster" and "Song (Live)" are usually listed under the plain title
    // downloader tags such as "Song - Spotimate.app" or "Song [example.com]" are not part of the title
    const untagged = String(meta.title || '').replace(/\s*[-–|]\s*[^-–|]*\b[a-z0-9-]+\.(app|com|net|org|io|to|fm|me|xyz)\b[^-–|]*$/i, '').replace(/\s*\[[^\]]*\.(app|com|net|org|io|to|fm|me|xyz)\]\s*$/i, '');
    const clean = untagged.replace(/\s+[-–]\s+.*\b(remaster(ed)?|live|mono|stereo|version)\b.*$/i, '').replace(/\s*\((remaster(ed)?|live)[^)]*\)\s*$/i, '').trim();
    const base = { track_name: clean || meta.title, artist_name: meta.artist || '' };
    let rec = null;
    if (meta.album && meta.duration > 0 && meta.artist) {   // /get needs an artist; without one, go to /search
      rec = await fetchJson(LRCLIB + '/get?' + qs(Object.assign({}, base, { album_name: meta.album, duration: Math.round(meta.duration) })), sig);
      if (rec && rec.instrumental) rec = null;   // instrumental entries have no words to show
    }
    if (!rec) {
      const list = await fetchJson(LRCLIB + '/search?' + qs(base), sig);
      rec = pickBest(Array.isArray(list) ? list : [], meta.duration);
    }
    if (!rec) return null;
    if (rec.syncedLyrics) {
      const lines = parseLrc(rec.syncedLyrics);
      if (lines.length) return { kind: 'synced', lines };
    }
    if (rec.plainLyrics) {
      const lines = parsePlain(rec.plainLyrics);
      if (lines.length) return { kind: 'plain', lines };
    }
    return null;
  }

  /* ---------- cache: IndexedDB with an in-memory fallback ---------- */
  const cache = (function () {
    let dbp = null;
    const mem = new Map();
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res) => {
        if (!g.indexedDB) return res(null);
        let r;
        try { r = g.indexedDB.open(CACHE_DB, 1); } catch (e) { return res(null); }
        r.onupgradeneeded = () => r.result.createObjectStore(CACHE_STORE);
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
        r.onblocked = () => res(null);
      });
      return dbp;
    }
    return {
      async get(key) {
        const db = await open();
        if (!db) return mem.get(key) || null;
        return new Promise((res) => {
          try {
            const q = db.transaction(CACHE_STORE).objectStore(CACHE_STORE).get(key);
            q.onsuccess = () => res(q.result || null);
            q.onerror = () => res(null);
          } catch (e) { res(null); }
        });
      },
      async put(key, val) {
        const db = await open();
        if (!db) { mem.set(key, val); return; }
        return new Promise((res) => {
          try {
            const tx = db.transaction(CACHE_STORE, 'readwrite');
            tx.objectStore(CACHE_STORE).put(val, key);
            tx.oncomplete = () => res();
            tx.onerror = tx.onabort = () => res();
          } catch (e) { res(); }
        });
      }
    };
  })();

  async function cachedLrclib(meta, sig) {
    const key = 'lrclib|' + norm(meta.artist) + '|' + norm(meta.title) + '|' + Math.round(meta.duration || 0);
    const c = await cache.get(key);
    if (c && (c.found || Date.now() - c.ts < MISS_TTL)) return c.found ? c : null;
    let res;
    try {
      res = await lookupLrclib(meta, sig);
    } catch (e) {
      if (sig && sig.aborted) throw e;
      return null;                                         // network trouble: do not cache a miss
    }
    if (!res) { await cache.put(key, { found: false, ts: Date.now() }); return null; }
    const rec = { found: true, ts: Date.now(), kind: res.kind, lines: res.lines };
    await cache.put(key, rec);
    return rec;
  }

  /* ---------- Tier 3: Whisper in a dedicated worker ---------- */
  // Speech models hallucinate filler on music. Drop the usual phantom lines.
  const JUNK = /^(\[?(music|applause|silence|laughter|instrumental)\]?|\.+|♪+|thank(s| you)( for watching)?[.!]*|you|subtitles? by .*)$/i;
  function cleanSegments(segs) {
    const out = [];
    let prev = '';
    for (const s of segs || []) {
      const txt = String(s.text || '').trim();
      if (!txt || JUNK.test(txt) || txt === prev) continue;
      prev = txt;
      out.push({ t: Math.max(0, Number(s.t) || 0), text: txt });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  let worker = null, seq = 0, loadedModel = '';
  const pending = new Map();

  function failWorker(err) {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    if (worker) worker.terminate();
    worker = null;
    loadedModel = '';
  }

  function getWorker() {
    if (worker) return worker;
    if (typeof Worker === 'undefined') throw new Error('Web Workers are not available in this browser.');
    worker = new Worker(WORKER_URL, { type: 'module' });
    worker.onmessageerror = () => { if (typeof failWorker === 'function') failWorker(new Error('Worker message could not be read.')); };
    worker.onmessage = (e) => {
      const m = e.data || {};
      const p = pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { if (p.onProgress) p.onProgress(m.p); return; }
      pending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(m.message || 'Transcription failed.'));
      else p.resolve(m);
    };
    worker.onerror = () => failWorker(new Error('The lyrics worker stopped unexpectedly.'));
    return worker;
  }

  function call(msg, transfer, onProgress) {
    const w = getWorker();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress });
      w.postMessage(Object.assign({ id }, msg), transfer || []);
    });
  }

  // Decode any browser-supported file and resample to 16 kHz mono, which Whisper expects.
  async function decodeTo16k(buf) {
    const OAC = g.OfflineAudioContext || g.webkitOfflineAudioContext;
    if (!OAC) throw new Error('OfflineAudioContext is not available.');
    const probe = new OAC(1, 1, 44100);
    const decoded = await probe.decodeAudioData(buf.slice(0));
    const len = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
    const off = new OAC(1, len, SAMPLE_RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    return rendered.getChannelData(0);
  }

  async function transcribeLocal(buf, opts) {
    const sig = opts.signal;
    const multilingual = !/\.en$/.test(WHISPER_MODEL);
    const onAbort = () => failWorker(abortError());
    if (sig) sig.addEventListener('abort', onAbort, { once: true });
    try {
      throwIfAborted(sig);
      const pcm = await decodeTo16k(buf);
      throwIfAborted(sig);
      if (loadedModel !== WHISPER_MODEL) {
        const progress = (p) => opts.onProgress && opts.onProgress(p);
        const wantGpu = !!(g.navigator && g.navigator.gpu);
        try {
          await call({ type: 'init', model: WHISPER_MODEL, device: wantGpu ? 'webgpu' : 'wasm', transformersUrl: TRANSFORMERS_URL }, [], progress);
        } catch (e) {
          if (!wantGpu || (sig && sig.aborted)) throw e;
          await call({ type: 'init', model: WHISPER_MODEL, device: 'wasm', transformersUrl: TRANSFORMERS_URL }, [], progress);
        }
        loadedModel = WHISPER_MODEL;
      }
      const CH = SAMPLE_RATE * CHUNK_SECONDS;
      const segs = [];
      for (let off = 0; off < pcm.length; off += CH) {
        throwIfAborted(sig);
        const slice = pcm.slice(off, Math.min(pcm.length, off + CH));  // copy, so the buffer can be transferred
        const r = await call({ type: 'chunk', pcm: slice, offset: off / SAMPLE_RATE, multilingual, language: multilingual ? undefined : 'en' }, [slice.buffer]);
        for (const s of r.segs || []) segs.push(s);
        if (opts.onProgress) opts.onProgress(Math.min(1, (off + CH) / pcm.length));
      }
      return cleanSegments(segs);
    } finally {
      if (sig) sig.removeEventListener('abort', onAbort);
    }
  }

  /* ---------- public: resolve lyrics for one track ---------- */
  // track: { name, size, title, artist, album, duration, lrc }  (library record)
  // opts:  { buffer (ArrayBuffer of the audio file, or null for streams), duration (s),
  //          allowAI, signal, onStatus(text) }
  async function resolve(track, opts) {
    opts = opts || {};
    const sig = opts.signal;
    const say = opts.onStatus || (() => {});
    throwIfAborted(sig);
    const buf = opts.buffer || null;

    // Tier 1: embedded tags, then a paired .lrc file
    let id3 = null;
    if (buf) {
      say('Checking file tags…');
      try { id3 = parseId3Lyrics(buf); } catch (e) { id3 = null; }
    }
    if (id3 && id3.synced && id3.synced.length) return ok('synced', id3.synced, 'id3-sylt');
    if (track.lrc) {
      const l = parseLrc(track.lrc);
      if (l.length) return ok('synced', l, 'lrc-file');
    }
    if (id3 && id3.plain) {
      const pl = parsePlain(id3.plain);
      if (pl.length) return ok('plain', pl, 'id3-uslt');
    }

    // Tier 2: LRCLIB (works for local files and streams alike)
    if (track.title) {
      say('Searching LRCLIB…');
      const hit = await cachedLrclib({
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: opts.duration || track.duration || 0
      }, sig);
      throwIfAborted(sig);
      if (hit) return ok(hit.kind, hit.lines, 'lrclib');
    }

    // Tier 3: optional local transcription (needs the file bytes, so never for streams)
    if (opts.allowAI && buf) {
      if (Math.max(opts.duration || 0, track.duration || 0) > MAX_AI_SECONDS) { say('Track too long for AI transcription'); return none(); }
      const key = 'ai|' + norm(track.name) + '|' + (track.size || 0);
      const c = await cache.get(key);
      if (c && (c.found || Date.now() - c.ts < MISS_TTL)) return c.found ? ok('synced', c.lines, 'ai') : none();
      say('Transcribing locally…');
      let lines;
      try {
        lines = await transcribeLocal(buf, {
          signal: sig,
          onProgress: (p) => say('Transcribing locally… ' + Math.round(p * 100) + '%')
        });
      } catch (e) {
        if (sig && sig.aborted) throw e;
        say('Transcription unavailable');
        return none();
      }
      await cache.put(key, lines.length ? { found: true, ts: Date.now(), lines } : { found: false, ts: Date.now() });
      return lines.length ? ok('synced', lines, 'ai') : none();
    }
    return none();
  }

  g.LyricsEngine = {
    resolve,
    parseLrc,
    parsePlain,
    parseId3Lyrics,
    sylToLines,
    pickBest,
    cleanSegments,
    cancelTranscription: () => failWorker(abortError())
  };
})(typeof window !== 'undefined' ? window : globalThis);
