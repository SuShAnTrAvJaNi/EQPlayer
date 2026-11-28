// Run: node tests/engine.test.js   (Node 18+)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

global.window = global;
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'lyrics', 'engine.js'), 'utf8'));
const E = window.LyricsEngine;

// ---------- LRC ----------
{
  const lrc = '[ti:Test]\n[offset:500]\n[00:01.00]Hello\n[00:03.50][00:09.25]Chorus line\n[bad line]\n';
  const p = E.parseLrc(lrc);
  assert.deepStrictEqual(p.map((x) => +x.t.toFixed(2)), [1.5, 4.0, 9.75]);
  assert.strictEqual(p[0].text, 'Hello');
  assert.strictEqual(p[1].text, 'Chorus line');
  assert.strictEqual(p[2].text, 'Chorus line');
  console.log('ok  LRC timestamps, offset tag, multi-stamp lines');
}

// ---------- ID3 builders ----------
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ss = (n) => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];
const ascii = (s) => [...Buffer.from(s, 'latin1')];
const frameV3 = (id, data) => [...ascii(id), ...u32(data.length), 0, 0, ...data];
const frameV4 = (id, data) => [...ascii(id), ...ss(data.length), 0, 0, ...data];
const tagBytes = (ver, frames) => {
  const body = frames.flat();
  return [...ascii('ID3'), ver, 0, 0, ...ss(body.length), ...body];
};
const toAB = (arr) => new Uint8Array(arr).buffer;
const syltEntries = (pairs) => pairs.flatMap(([text, ms]) => [...ascii(text), 0, ...u32(ms)]);
// SYLT: enc(0) lang(eng) fmt(2=ms) type(1=lyrics) descriptor(empty) entries
const sylt = [0, ...ascii('eng'), 2, 1, 0, ...syltEntries([['Hello ', 1000], ['world', 1500], ['\nNext ', 2000], ['line', 2500]])];
// USLT: enc(0) lang(eng) descriptor(empty) text
const uslt = [0, ...ascii('eng'), 0, ...ascii('Plain line one\nline two')];

// ---------- SYLT (v2.3) ----------
{
  const r = E.parseId3Lyrics(toAB(tagBytes(3, [frameV3('SYLT', sylt), frameV3('USLT', uslt)])));
  assert.deepStrictEqual(r.synced, [{ t: 1, text: 'Hello world' }, { t: 2, text: 'Next line' }]);
  assert.strictEqual(r.plain, 'Plain line one\nline two');
  console.log('ok  ID3 v2.3 SYLT lines + USLT plain');
}

// ---------- USLT only, v2.4 with syncsafe sizes ----------
{
  const r = E.parseId3Lyrics(toAB(tagBytes(4, [frameV4('USLT', uslt)])));
  assert.strictEqual(r.synced, null);
  assert.strictEqual(r.plain, 'Plain line one\nline two');
  console.log('ok  ID3 v2.4 USLT with syncsafe frame size');
}

// ---------- no tags / garbage ----------
{
  const r = E.parseId3Lyrics(toAB([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  assert.strictEqual(r.synced, null);
  assert.strictEqual(r.plain, null);
  console.log('ok  non-ID3 bytes return nothing');
}

// ---------- plain text ----------
{
  const p = E.parsePlain('\n\nfirst\n\nsecond\n\n');
  assert.deepStrictEqual(p.map((x) => x.text), ['first', '', 'second']);
  assert.ok(p.every((x) => x.t === null));
  console.log('ok  plain lyrics trim leading/trailing blanks');
}

// ---------- SYLT line merging directly ----------
{
  const lines = E.sylToLines([{ t: 5, text: 'a' }, { t: 5.5, text: 'b\n' }, { t: 6, text: 'c' }]);
  assert.deepStrictEqual(lines, [{ t: 5, text: 'ab' }, { t: 6, text: 'c' }]);
  console.log('ok  sylToLines breaks on newline');
}

// ---------- LRCLIB pick: duration must match, synced preferred ----------
{
  const list = [
    { syncedLyrics: '[00:01.00]wrong length', duration: 300 },
    { plainLyrics: 'right length plain', duration: 200.5 },
    { syncedLyrics: '[00:01.00]right', duration: 201 }
  ];
  assert.strictEqual(E.pickBest(list, 200).syncedLyrics, '[00:01.00]right');
  assert.strictEqual(E.pickBest([list[0]], 200), null, 'no near-duration match must not return another recording');
  assert.strictEqual(E.pickBest([list[0]], 0).syncedLyrics, '[00:01.00]wrong length', 'unknown duration accepts first usable');
  console.log('ok  LRCLIB result picking');
}

// ---------- Whisper output clean-up ----------
{
  const segs = E.cleanSegments([
    { t: 3, text: ' Hi there ' }, { t: 4, text: '[Music]' }, { t: 5, text: 'Hi there' },
    { t: 1, text: 'Thank you.' }, { t: 2, text: '' }, { t: 6, text: 'Real line' }
  ]);
  assert.deepStrictEqual(segs, [{ t: 3, text: 'Hi there' }, { t: 6, text: 'Real line' }]);
  console.log('ok  transcription hallucination filter');
}

// ---------- Parametric EQ Helpers, ReplayGain & USB Folder Tree ----------
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'dsp', 'helpers.js'), 'utf8'));
const H = window.EQHelpers;

{
  assert.strictEqual(H.formatFreq(62), '62');
  assert.strictEqual(H.formatFreq(1000), '1k');
  assert.strictEqual(H.formatFreq(2500), '2.5k');
  assert.strictEqual(H.formatFreq(16000), '16k');
  console.log('ok  formatFreq');
}

{
  const aeq = [
    '# Sample AutoEQ ParametricEQ.txt',
    'Preamp: -6.2 dB',
    'Filter 1: ON LSC Fc 105 Hz Gain 4.8 dB Q 0.71',
    'Filter 2: OFF PK Fc 200 Hz Gain 5.0 dB Q 1.0',
    'Filter 3: ON PK Fc 1000 Hz Gain -2.4 dB Q 2.1',
    'Filter 4: ON HSC Fc 10000 Hz Gain 3.0 dB Q 0.7'
  ].join('\n');
  const parsed = H.parseAutoEqText(aeq);
  assert.ok(parsed);
  assert.strictEqual(parsed.pre, -6.2);
  assert.strictEqual(parsed.auto, false);
  assert.strictEqual(parsed.gains.length, 10);
  const idx105 = parsed.freqs.indexOf(105);
  const idx1k = parsed.freqs.indexOf(1000);
  const idx10k = parsed.freqs.indexOf(10000);
  assert.ok(idx105 >= 0 && idx1k >= 0 && idx10k >= 0);
  assert.strictEqual(parsed.types[idx105], 'lowshelf');
  assert.strictEqual(parsed.gains[idx105], 4.8);
  assert.strictEqual(parsed.qs[idx105], 0.71);
  assert.strictEqual(parsed.types[idx1k], 'peaking');
  assert.strictEqual(parsed.gains[idx1k], -2.4);
  assert.strictEqual(parsed.types[idx10k], 'highshelf');
  assert.ok(!parsed.freqs.includes(200), 'OFF filter must be ignored');

  // More than 10 filters keeps top 10 by |gain| sorted by frequency
  const many = Array.from({ length: 12 }, (_, i) => `Filter ${i + 1}: ON PK Fc ${50 * (i + 1)} Hz Gain ${(i + 1) * 0.5} dB Q 1.4`).join('\n');
  const parsedMany = H.parseAutoEqText(many);
  assert.strictEqual(parsedMany.gains.length, 10);
  assert.ok(!parsedMany.freqs.includes(50) && !parsedMany.freqs.includes(100));
  console.log('ok  parseAutoEqText');
}

{
  const singleJson = JSON.stringify({
    name: 'Studio Target',
    gains: [1, 2, 0, 0, -1, 0, 1, 2, 3, 1],
    freqs: [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
    qs: [0.8, 1.4, 1.4, 1.4, 2.0, 1.4, 1.4, 1.4, 1.4, 0.7],
    types: ['lowshelf', 'peaking', 'peaking', 'peaking', 'peaking', 'peaking', 'peaking', 'peaking', 'peaking', 'highshelf'],
    pre: -3.0
  });
  const res1 = H.parsePresetImport(singleJson, 'ignored.json');
  assert.strictEqual(res1.length, 1);
  assert.strictEqual(res1[0].name, 'Studio Target');
  assert.strictEqual(res1[0].preset.types[0], 'lowshelf');

  const bundleJson = JSON.stringify({
    presets: {
      Warm: { gains: [3, 2, 1, 0, 0, 0, -1, -1, -2, -2] },
      Bright: { gains: [-1, 0, 0, 0, 0, 1, 2, 3, 3, 2] }
    }
  });
  const res2 = H.parsePresetImport(bundleJson, 'bundle.json');
  assert.strictEqual(res2.length, 2);
  assert.strictEqual(res2[0].name, 'Warm');
  assert.strictEqual(res2[1].preset.freqs.length, 10);

  const res3 = H.parsePresetImport('Filter 1: ON PK Fc 440 Hz Gain 2.5 dB Q 1.2', 'HD600.txt');
  assert.strictEqual(res3.length, 1);
  assert.strictEqual(res3[0].name, 'HD600');
  console.log('ok  parsePresetImport (single JSON, bundle JSON, AutoEQ txt)');
}

{
  assert.deepStrictEqual(H.parseReplayGainValue('REPLAYGAIN_TRACK_GAIN', '-5.42 dB'), { kind: 'track', db: -5.42 });
  assert.deepStrictEqual(H.parseReplayGainValue('replaygain_album_gain', '+1.5 dB'), { kind: 'album', db: 1.5 });
  assert.deepStrictEqual(H.parseReplayGainValue('R128_TRACK_GAIN', '-1280'), { kind: 'track', db: 0 });
  assert.strictEqual(H.parseReplayGainValue('COMMENT', 'hello'), null);

  // Quiet sine/square wave boosted toward -14 dB RMS without clipping -1 dBFS peak
  const quiet = new Float32Array(1000).fill(0.05); // -26.02 dB
  const boost = H.computeLoudnessGainDb([quiet], -14);
  assert.ok(boost > 11 && boost <= 12, 'quiet signal should be boosted safely');

  const hot = new Float32Array(1000).fill(0.95);
  const cut = H.computeLoudnessGainDb([hot], -14);
  assert.ok(cut < 0, 'hot signal should be attenuated');
  console.log('ok  ReplayGain & computeLoudnessGainDb');
}

{
  const tracks = [
    { id: 1, name: '02.mp3', folder: 'USB_DRIVE/Rock/CD2' },
    { id: 2, name: '01.mp3', folder: 'USB_DRIVE/Rock/CD1' },
    { id: 3, name: '03.mp3', folder: 'USB_DRIVE/Rock' },
    { id: 4, name: 'intro.mp3', folder: 'USB_DRIVE' },
    { id: 5, name: 'loose.mp3', folder: '' }
  ];

  const root = H.listFolderLevel(tracks, []);
  assert.strictEqual(root.folders.length, 1);
  assert.strictEqual(root.folders[0].name, 'USB_DRIVE');
  assert.strictEqual(root.folders[0].trackCount, 4);
  assert.strictEqual(root.folders[0].subfolderCount, 1);
  assert.deepStrictEqual(root.files.map((x) => x.id), [5]);

  const rock = H.listFolderLevel(tracks, ['USB_DRIVE', 'Rock']);
  assert.deepStrictEqual(rock.folders.map((f) => f.name), ['CD1', 'CD2']);
  assert.deepStrictEqual(rock.files.map((f) => f.id), [3]);

  const allInRock = H.tracksInFolder(tracks, ['USB_DRIVE', 'Rock']);
  assert.deepStrictEqual(allInRock.map((t) => t.id), [3, 2, 1]);
  console.log('ok  USB folder tree navigation & sorting');
}

console.log('\nall engine tests passed');
