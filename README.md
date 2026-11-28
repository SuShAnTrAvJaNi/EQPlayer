# EQPlayer

A parametric EQ music player that runs in the browser as a Progressive Web App.
Local MP3s go through a Web Audio EQ, reverb and Headroom chain. Synced lyrics come from the file, a `.lrc` file, LRCLIB, or optional on-device Whisper.

Live site: https://sushantravjani.github.io/EQPlayer/

## Files

| File | What it is |
| --- | --- |
| `index.html` | Markup and layout |
| `styles.css` | All styling (Liquid Glass look, themes, motion switch) |
| `app.js` | The player: audio graph, library, queue, Settings, import |
| `config.js` | Build-time settings (client IDs, model name, URLs) |
| `lyrics/engine.js` | Lyrics pipeline: ID3 SYLT/USLT, `.lrc`, LRCLIB, Whisper hand-off |
| `lyrics/worker.js` | Web Worker that runs Whisper with Transformers.js |
| `streaming/providers.js` | Spotify (PKCE, Web Playback SDK) and Apple Music (MusicKit JS) |
| `sw.js` | Service worker: offline cache, update prompt |
| `manifest.json`, `icon-*.png` | Home Screen install |
| `tests/engine.test.js` | Unit tests for the lyrics parsers and matcher |

## Run it

Any static server works. From the folder:

    python3 -m http.server 8765 --bind 127.0.0.1

Then open http://127.0.0.1:8765/index.html. Service workers need `https` or `localhost`.

## Add it to the iPhone or iPad Home Screen

Open the site in Safari, tap Share, then Add to Home Screen. Updates arrive through the "Update available" button; the app does not reload by itself.

## Streaming keys (optional)

Spotify and Apple Music need your own developer keys. Enter them in Settings, then tap "Save keys on this device". They are stored only in this browser (`localStorage`, key `eqp-cfg-v1`). You can also put them in `config.js`:

- `VITE_SPOTIFY_CLIENT_ID`: a Spotify app client ID. Add the app's URL as a redirect URI.
- `VITE_APPLE_MUSIC_DEVELOPER_TOKEN`: a MusicKit developer token (JWT) signed with your Apple key.

Streamed tracks play through Spotify's or Apple's own player, so the EQ does not process them. Playback needs a Premium or Apple Music subscription.

## Lyrics

Lyrics are off by default; turn them on in the Lyrics panel. The order of lookup is:

1. Lyrics embedded in the MP3 (ID3 `SYLT` or `USLT`), or a `.lrc` file added with the MP3.
2. LRCLIB, matched by title and artist.
3. Whisper, only if the AI option is on. The model downloads once (about 40–45 MB for `Xenova/whisper-tiny.en`, quantised) and is then kept in the browser's Cache Storage, so it runs offline.

## Tests

    node tests/engine.test.js

These cover the lyrics parsers and matcher. The UI was also checked with Playwright in headless Chrome: play and pause, the EQ sheet, Settings, folder import and the preamp display. Spotify and Apple playback, LRCLIB network calls and Whisper speed need a real device and account.

## Notes

- Reset (in the EQ panel) resets the EQ settings only. Use Clear all in the library to remove songs.
- The audio output picker works where the browser supports `setSinkId` (Chrome, Edge, Android). On iPhone and iPad, use AirPlay from Control Center.
