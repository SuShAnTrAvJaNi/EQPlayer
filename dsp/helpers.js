/* EQ Player - pure helpers for Parametric EQ, AutoEQ import, ReplayGain, and USB-style Folder Tree.
 * Exposed on window.EQHelpers (and usable in Node unit tests).
 */
(function (g) {
  'use strict';

  const DEFAULT_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function formatFreq(hz) {
    const f = Math.round(Number(hz) || 0);
    if (f >= 1000) {
      const k = f / 1000;
      return (Number.isInteger(k) ? String(k) : k.toFixed(k >= 10 ? 1 : 2).replace(/\.?0+$/, '')) + 'k';
    }
    return String(f);
  }

  function normType(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'lsc' || s === 'ls' || s === 'lowshelf' || s === 'low_shelf') return 'lowshelf';
    if (s === 'hsc' || s === 'hs' || s === 'highshelf' || s === 'high_shelf') return 'highshelf';
    return 'peaking';
  }

  function parseAutoEqText(text) {
    const src = String(text || '');
    const lines = src.split(/\r\n|\n|\r/);
    let pre = 0;
    let hasPre = false;
    const found = [];

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      const pm = line.match(/^Preamp:\s*([+-]?\d+(?:[.,]\d+)?)\s*(?:dB)?/i);
      if (pm) {
        pre = clamp(parseFloat(pm[1].replace(',', '.')), -24, 6);
        hasPre = true;
        continue;
      }

      // Filter 1: ON PK Fc 105 Hz Gain 4.8 dB Q 0.71
      const fm = line.match(
        /^Filter(?:\s+\d+)?\s*:\s*(ON|OFF)\s+(PK|PEAKING|LSC|LS|LOWSHELF|HSC|HS|HIGHSHELF)\s+Fc\s+(\d+(?:[.,]\d+)?)\s*(?:Hz)?\s+Gain\s+([+-]?\d+(?:[.,]\d+)?)\s*(?:dB)?(?:\s+Q\s+(\d+(?:[.,]\d+)?))?/i
      );
      if (fm) {
        if (fm[1].toUpperCase() === 'OFF') continue;
        const freq = clamp(parseFloat(fm[3].replace(',', '.')), 20, 20000);
        const gain = clamp(parseFloat(fm[4].replace(',', '.')), -12, 12);
        const q = fm[5] ? clamp(parseFloat(fm[5].replace(',', '.')), 0.2, 12) : 1.41;
        found.push({ type: normType(fm[2]), freq, gain, q });
      }
    }

    if (!found.length && !hasPre) return null;

    let selected = found.slice();
    if (selected.length > 10) {
      selected = selected
        .slice()
        .sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain))
        .slice(0, 10)
        .sort((a, b) => a.freq - b.freq);
    } else {
      selected.sort((a, b) => a.freq - b.freq);
    }

    const usedFreqs = selected.map((x) => x.freq);
    const padFreqs = DEFAULT_FREQS.filter((df) => usedFreqs.every((uf) => Math.abs(uf - df) / df > 0.15));
    while (selected.length < 10) {
      const f = padFreqs.length ? padFreqs.shift() : DEFAULT_FREQS[selected.length];
      selected.push({ type: 'peaking', freq: f, gain: 0, q: 1.41 });
    }
    selected.sort((a, b) => a.freq - b.freq);

    return {
      gains: selected.map((x) => Math.round(x.gain * 10) / 10),
      freqs: selected.map((x) => Math.round(x.freq)),
      qs: selected.map((x) => Math.round(x.q * 100) / 100),
      types: selected.map((x) => x.type),
      pre: Math.round(pre * 10) / 10,
      auto: !hasPre,
      bass: 0,
      treble: 0
    };
  }

  function normalizePresetObj(p) {
    if (!p || !Array.isArray(p.gains) || p.gains.length !== 10) return null;
    if (!p.gains.every((x) => typeof x === 'number' && isFinite(x))) return null;
    const freqs = Array.isArray(p.freqs) && p.freqs.length === 10
      ? p.freqs.map((f, i) => (typeof f === 'number' && isFinite(f) ? clamp(Math.round(f), 20, 20000) : DEFAULT_FREQS[i]))
      : DEFAULT_FREQS.slice();
    const qs = Array.isArray(p.qs) && p.qs.length === 10
      ? p.qs.map((q) => (typeof q === 'number' && isFinite(q) ? clamp(Math.round(q * 100) / 100, 0.2, 12) : 1.41))
      : Array(10).fill(1.41);
    const types = Array.isArray(p.types) && p.types.length === 10
      ? p.types.map(normType)
      : Array(10).fill('peaking');
    return {
      gains: p.gains.map((x) => clamp(Math.round(x * 10) / 10, -12, 12)),
      freqs,
      qs,
      types,
      pre: typeof p.pre === 'number' && isFinite(p.pre) ? clamp(p.pre, -24, 6) : 0,
      auto: p.auto !== false,
      bass: typeof p.bass === 'number' && isFinite(p.bass) ? clamp(p.bass, -12, 12) : 0,
      treble: typeof p.treble === 'number' && isFinite(p.treble) ? clamp(p.treble, -12, 12) : 0,
      bal: typeof p.bal === 'number' && isFinite(p.bal) ? clamp(p.bal, -100, 100) : undefined,
      width: typeof p.width === 'number' && isFinite(p.width) ? clamp(p.width, 0, 200) : undefined,
      revType: typeof p.revType === 'string' ? p.revType : undefined,
      revMix: typeof p.revMix === 'number' && isFinite(p.revMix) ? clamp(p.revMix, 0, 100) : undefined
    };
  }

  function parsePresetImport(text, filename) {
    const baseName = String(filename || 'Imported Preset')
      .replace(/\.[^.]+$/, '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 30) || 'Imported Preset';

    const trimmed = String(text || '').trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj && Array.isArray(obj.gains)) {
          const norm = normalizePresetObj(obj);
          if (!norm) return null;
          const name = String(obj.name || baseName).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30) || baseName;
          return [{ name, preset: norm }];
        }
        const bundle = obj && obj.presets && typeof obj.presets === 'object' ? obj.presets : obj;
        if (bundle && typeof bundle === 'object' && !Array.isArray(bundle)) {
          const out = [];
          for (const [k, v] of Object.entries(bundle)) {
            const norm = normalizePresetObj(v);
            if (norm) out.push({ name: String(k).trim().slice(0, 30) || baseName, preset: norm });
          }
          if (out.length) return out;
        }
      } catch (e) { /* fall through to AutoEQ parser */ }
    }

    const aeq = parseAutoEqText(trimmed);
    if (aeq) return [{ name: baseName, preset: aeq }];
    return null;
  }

  function parseReplayGainValue(desc, val) {
    const key = String(desc || '').trim().toUpperCase();
    const s = String(val || '').trim();
    if (key === 'REPLAYGAIN_TRACK_GAIN' || key === 'REPLAYGAIN_ALBUM_GAIN') {
      const m = s.match(/([+-]?\d+(?:[.,]\d+)?)/);
      if (!m) return null;
      const db = parseFloat(m[1].replace(',', '.'));
      return isFinite(db) ? { kind: key === 'REPLAYGAIN_TRACK_GAIN' ? 'track' : 'album', db: clamp(Math.round(db * 100) / 100, -24, 24) } : null;
    }
    if (key === 'R128_TRACK_GAIN' || key === 'R128_ALBUM_GAIN') {
      const n = parseFloat(s);
      if (!isFinite(n)) return null;
      // R128_*_GAIN is Q7.8 relative to -23 LUFS; shift +5 dB toward -18/-14 LUFS portable target
      const db = clamp(Math.round((n / 256 + 5) * 100) / 100, -24, 24);
      return { kind: key === 'R128_TRACK_GAIN' ? 'track' : 'album', db };
    }
    return null;
  }

  function computeLoudnessGainDb(channels, targetDb) {
    const target = typeof targetDb === 'number' && isFinite(targetDb) ? targetDb : -14;
    if (!channels || !channels.length) return 0;
    let sumSq = 0;
    let count = 0;
    let peak = 0;
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      if (!ch || !ch.length) continue;
      // Stride slightly on very long buffers so analysis stays sub-10ms
      const step = ch.length > 4000000 ? 4 : 1;
      for (let i = 0; i < ch.length; i += step) {
        const v = ch[i];
        const av = v < 0 ? -v : v;
        if (av > peak) peak = av;
        sumSq += v * v;
        count++;
      }
    }
    if (!count || peak < 1e-5) return 0;
    const rms = Math.sqrt(sumSq / count);
    if (rms < 1e-5) return 0;
    const rmsDb = 20 * Math.log10(rms);
    const peakDb = 20 * Math.log10(peak);
    const desired = clamp(target - rmsDb, -18, 12);
    const maxSafe = -1.0 - peakDb;
    return Math.round(Math.min(desired, maxSafe) * 10) / 10;
  }

  function splitFolder(folderStr) {
    return String(folderStr || '')
      .replace(/\\/g, '/')
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function listFolderLevel(tracks, pathParts) {
    const prefix = Array.isArray(pathParts) ? pathParts : splitFolder(pathParts);
    const folderMap = new Map();
    const files = [];

    for (const t of tracks || []) {
      const segs = splitFolder(t.folder);
      if (segs.length < prefix.length) continue;
      let match = true;
      for (let i = 0; i < prefix.length; i++) {
        if (segs[i] !== prefix[i]) { match = false; break; }
      }
      if (!match) continue;

      if (segs.length === prefix.length) {
        files.push(t);
      } else {
        const childName = segs[prefix.length];
        let entry = folderMap.get(childName);
        if (!entry) {
          entry = {
            name: childName,
            path: prefix.concat(childName),
            trackCount: 0,
            subfolders: new Set()
          };
          folderMap.set(childName, entry);
        }
        entry.trackCount++;
        if (segs.length > prefix.length + 1) entry.subfolders.add(segs[prefix.length + 1]);
      }
    }

    const folders = [...folderMap.values()]
      .map((f) => ({ name: f.name, path: f.path, trackCount: f.trackCount, subfolderCount: f.subfolders.size }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    files.sort((a, b) => (a.name || a.title || '').localeCompare(b.name || b.title || '', undefined, { numeric: true, sensitivity: 'base' }));
    return { folders, files };
  }

  function tracksInFolder(tracks, pathParts) {
    const prefix = Array.isArray(pathParts) ? pathParts : splitFolder(pathParts);
    const out = [];
    for (const t of tracks || []) {
      const segs = splitFolder(t.folder);
      if (segs.length < prefix.length) continue;
      let match = true;
      for (let i = 0; i < prefix.length; i++) {
        if (segs[i] !== prefix[i]) { match = false; break; }
      }
      if (match) out.push(t);
    }
    out.sort((a, b) => {
      const fa = String(a.folder || ''), fb = String(b.folder || '');
      const fc = fa.localeCompare(fb, undefined, { numeric: true, sensitivity: 'base' });
      if (fc !== 0) return fc;
      return (a.name || a.title || '').localeCompare(b.name || b.title || '', undefined, { numeric: true, sensitivity: 'base' });
    });
    return out;
  }

  g.EQHelpers = {
    DEFAULT_FREQS,
    formatFreq,
    parseAutoEqText,
    normalizePresetObj,
    parsePresetImport,
    parseReplayGainValue,
    computeLoudnessGainDb,
    splitFolder,
    listFolderLevel,
    tracksInFolder
  };
})(typeof window !== 'undefined' ? window : globalThis);
