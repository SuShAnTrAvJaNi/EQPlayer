/* EQ Player runtime configuration.
 *
 * This is a plain plain-HTML app, so there is no build step to read .env files.
 * The VITE_* names mirror what you would put in a Vite .env file. If you bundle the
 * app later, generate this file from your environment (only VITE_* values belong here:
 * everything in this file is visible to anyone who loads the page).
 *
 *  VITE_SPOTIFY_CLIENT_ID          Spotify Developer Dashboard > app > Client ID.
 *  VITE_SPOTIFY_REDIRECT_URI       Must match a Redirect URI registered in the dashboard EXACTLY
 *                                  (Spotify requires https, or http://127.0.0.1 for local tests).
 *                                  Empty = current page URL without query string.
 *  VITE_APPLE_MUSIC_DEVELOPER_TOKEN  A developer JWT (ES256) signed with your MusicKit private key.
 *                                  It must be generated on a server; never ship the .p8 key to the browser.
 *  VITE_WHISPER_MODEL              Transformers.js ASR model id. 'Xenova/whisper-tiny.en' is the fastest;
 *                                  'Xenova/whisper-base.en' is more accurate and larger.
 *  VITE_TRANSFORMERS_URL           ESM build of @huggingface/transformers, loaded inside the worker.
 *  VITE_LRCLIB_BASE                LRCLIB API base URL.
 */
window.EQP_CONFIG = {
  VITE_SPOTIFY_CLIENT_ID: 'YOUR_SPOTIFY_CLIENT_ID',
  VITE_SPOTIFY_REDIRECT_URI: '',
  VITE_APPLE_MUSIC_DEVELOPER_TOKEN: 'YOUR_APPLE_MUSIC_DEVELOPER_TOKEN',
  VITE_WHISPER_MODEL: 'Xenova/whisper-tiny.en',
  VITE_TRANSFORMERS_URL: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm',
  VITE_LRCLIB_BASE: 'https://lrclib.net/api',
  VITE_LYRICS_WORKER: 'lyrics/worker.js'
};
