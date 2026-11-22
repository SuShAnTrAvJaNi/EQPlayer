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

console.log('\nall engine tests passed');
