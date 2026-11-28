/* EQ Player - streaming providers.
 *   Spotify:     OAuth 2.0 Authorization Code + PKCE (no client secret in the browser),
 *                Web API for library import, Web Playback SDK for Premium playback.
 *   Apple Music: MusicKit JS v3 (needs a developer token signed on your server),
 *                library import and MusicKit playback.
 * Streamed audio is played by Spotify's / Apple's own players, so it never reaches the EQ's Web Audio graph.
 * No DOM assumptions beyond script/fetch/location; the UI lives in index.html.
 */
(function (g) {
  'use strict';

  const SAVED_CFG = (() => { try { return JSON.parse(localStorage.getItem('eqp-cfg-v1') || '{}'); } catch (e) { return {}; } })();
  const CFG = Object.assign({}, g.EQP_CONFIG || {}, SAVED_CFG);
  const KEY = 'eqp-stream-auth-v1';
  const SPOTIFY_API = 'https://api.spotify.com/v1';
  const SPOTIFY_ACCOUNTS = 'https://accounts.spotify.com';
  const SPOTIFY_SCOPES = [
    'user-library-read', 'playlist-read-private', 'playlist-read-collaborative',
    'user-read-email', 'user-read-private', 'streaming',
    'user-read-playback-state', 'user-modify-playback-state'
  ];
  const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
  const MUSICKIT_URL = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';

  class StreamError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  /* ---------- events ---------- */
  const listeners = { state: new Set(), error: new Set() };
  const emit = (ev, data) => (listeners[ev] || new Set()).forEach((fn) => { try { fn(data); } catch (e) { /* keep others running */ } });
  const on = (ev, fn) => { if (!listeners[ev]) listeners[ev] = new Set(); listeners[ev].add(fn); return () => listeners[ev].delete(fn); };

  /* ---------- stored auth (tokens live in localStorage: see the security note in the README) ---------- */
  const readAuth = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const writeAuth = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* storage full or disabled */ } };

  const isPlaceholder = (v) => !v || /^YOUR_/i.test(v);
  const spotifyConfigured = () => !isPlaceholder(CFG.VITE_SPOTIFY_CLIENT_ID);
  const appleConfigured = () => !isPlaceholder(CFG.VITE_APPLE_MUSIC_DEVELOPER_TOKEN);

  /* ================= Spotify ================= */
  const b64url = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const randomB64 = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const redirectUri = () => CFG.VITE_SPOTIFY_REDIRECT_URI || (location.origin + location.pathname);

  async function spotifyLogin() {
    if (!spotifyConfigured()) throw new StreamError('not_configured', 'Enter your Spotify client ID in Settings first.');
    const verifier = randomB64(64);
    const state = randomB64(16);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    sessionStorage.setItem('eqp-spotify-pkce', JSON.stringify({ verifier, state }));
    const q = new URLSearchParams({
      client_id: CFG.VITE_SPOTIFY_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri(),
      scope: SPOTIFY_SCOPES.join(' '),
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state
    });
    location.assign(SPOTIFY_ACCOUNTS + '/authorize?' + q.toString());
  }

  async function tokenRequest(params) {
    const body = new URLSearchParams(Object.assign({ client_id: CFG.VITE_SPOTIFY_CLIENT_ID }, params));
    const r = await fetch(SPOTIFY_ACCOUNTS + '/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!r.ok) throw new StreamError('auth', 'Spotify sign-in failed (' + r.status + '). Try connecting again.');
    return r.json();
  }

  function saveSpotify(tok) {
    const a = readAuth();
    const prev = a.spotify || {};
    a.spotify = {
      access: tok.access_token,
      refresh: tok.refresh_token || prev.refresh,
      exp: Date.now() + (tok.expires_in || 3600) * 1000 - 60000
    };
    writeAuth(a);
  }

  let refreshing = null;
  async function spotifyToken(force) {
    const sp = readAuth().spotify;
    if (!sp || !sp.refresh) throw new StreamError('not_connected', 'Connect Spotify in Settings first.');
    if (!force && sp.exp > Date.now()) return sp.access;
    // one refresh at a time: parallel refreshes would invalidate each other under refresh-token rotation
    if (!refreshing) {
      refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: sp.refresh })
        .then((tok) => { saveSpotify(tok); refreshing = null; })
        .catch((e) => { refreshing = null; throw e; });
    }
    await refreshing;
    return readAuth().spotify.access;
  }

  // Call once at start-up. Returns null when the URL has no OAuth result.
  async function handleRedirect() {
    const u = new URL(location.href);
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    const err = u.searchParams.get('error');
    if (!code && !err) return null;
    history.replaceState(null, '', u.pathname);
    let pk = null;
    try { pk = JSON.parse(sessionStorage.getItem('eqp-spotify-pkce') || 'null'); } catch (e) { pk = null; }
    sessionStorage.removeItem('eqp-spotify-pkce');
    if (err) return { ok: false, msg: 'Spotify sign-in was cancelled.' };
    if (!pk || pk.state !== state) return { ok: false, msg: 'Spotify sign-in expired. Please try again.' };
    saveSpotify(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: pk.verifier }));
    return { ok: true, msg: 'Spotify connected' };
  }

  async function spGet(pathOrUrl, retried) {
    const tok = await spotifyToken();
    const url = /^https?:/.test(pathOrUrl) ? pathOrUrl : SPOTIFY_API + pathOrUrl;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + tok } });
    if (r.status === 401 && !retried) { await spotifyToken(true); return spGet(pathOrUrl, true); }
    if (r.status === 403) throw new StreamError('forbidden', 'Spotify refused this request (403). The playlist may be private or not shared with your account.');
    if (r.status === 429) { const wait = Math.ceil(+r.headers.get('Retry-After') || 60); throw new StreamError('rate_limited', 'Spotify is rate-limiting requests. Try again in ' + wait + ' seconds.'); }
    if (!r.ok) throw new StreamError('api', 'Spotify request failed (' + r.status + ').');
    return r.json();
  }

  function spotifyRecord(tr) {
    const imgs = (tr.album && tr.album.images) || [];
    const pick = imgs.find((i) => i.width && i.width <= 320) || imgs[imgs.length - 1];
    return {
      source: 'spotify',
      ext: tr.id,
      uri: tr.uri || ('spotify:track:' + tr.id),
      name: 'spotify:' + tr.id,
      title: tr.name || 'Untitled',
      artist: (tr.artists || []).map((a) => a.name).join(', '),
      album: (tr.album && tr.album.name) || '',
      duration: (tr.duration_ms || 0) / 1000,
      art: pick ? pick.url : '',
      size: 0,
      added: Date.now(),
      fmt: 'Spotify'
    };
  }

  // Development Mode (Feb 2026+): playlist items are only returned for playlists the user owns or
  // collaborates on, so other playlists are counted as skipped rather than failing the import.
  async function spotifyImport(opts) {
    const onProgress = (opts && opts.onProgress) || (() => {});
    const records = [];
    const seen = new Set();
    let skipped = 0;
    const addTrack = (e) => {
      const tr = e && (e.item || e.track);
      if (!tr || !tr.id || tr.type === 'episode' || e.is_local) return;
      if (seen.has(tr.id)) return;
      seen.add(tr.id);
      records.push(spotifyRecord(tr));
    };

    try {
      let next = '/me/tracks?limit=50';
      while (next) {
        const j = await spGet(next);
        (j.items || []).forEach((e) => addTrack({ item: e.track }));
        next = j.next || null;
      }
    } catch (err) {
      if (err.code !== 'forbidden' && err.code !== 'api') throw err;   // saved tracks are optional
    }

    const lists = [];
    let next = '/me/playlists?limit=50';
    while (next) {
      const j = await spGet(next);
      (j.items || []).forEach((p) => { if (p) lists.push(p); });
      next = j.next || null;
    }

    for (let i = 0; i < lists.length; i++) {
      const p = lists[i];
      onProgress('Playlist ' + (i + 1) + ' of ' + lists.length + ': ' + (p.name || ''));
      let n = '/playlists/' + encodeURIComponent(p.id) + '/items?limit=50';
      try {
        while (n) {
          const j = await spGet(n);
          (j.items || []).forEach(addTrack);
          n = j.next || null;
        }
      } catch (err) {
        if (err.code === 'forbidden') skipped++;
        else throw err;
      }
    }
    return { records, skipped, playlists: lists.length };
  }

  /* ----- Spotify Web Playback SDK ----- */
  const sp = { player: null, deviceId: null, ready: null, sdk: null, last: null };

  function loadSpotifySdk() {
    if (g.Spotify) return Promise.resolve();
    if (!sp.sdk) {
      sp.sdk = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          sp.sdk = null;
          reject(new StreamError('sdk_unavailable', 'The Spotify player did not load. Check your connection.'));
        }, 15000);
        g.onSpotifyWebPlaybackSDKReady = () => { clearTimeout(timer); resolve(); };
        const s = document.createElement('script');
        s.src = SDK_URL;
        s.async = true;
        s.onerror = () => {
          clearTimeout(timer);
          sp.sdk = null;
          reject(new StreamError('sdk_unavailable', 'Could not load the Spotify player.'));
        };
        document.head.appendChild(s);
      });
    }
    return sp.sdk;
  }

  function onSpotifyState(st) {
    if (!st || !st.track_window || !st.track_window.current_track) return;
    const cur = st.track_window.current_track;
    const prev = sp.last;
    // A track that finished: paused at 0 right after playing to within 1.5 s of its end.
    const ended = !!(st.paused && st.position === 0 && prev && prev.uri === cur.uri &&
      !prev.paused && prev.duration > 0 && prev.duration - prev.position < 1.5);
    const s = {
      source: 'spotify',
      uri: cur.uri,
      paused: !!st.paused,
      position: (st.position || 0) / 1000,
      duration: (st.duration || 0) / 1000,
      ts: Date.now(),
      ended
    };
    sp.last = { uri: s.uri, paused: s.paused, position: s.position, duration: s.duration };
    emit('state', s);
  }

  async function spotifyPlayer() {
    if (sp.player && sp.deviceId) return;
    if (!sp.ready) {
      sp.ready = (async () => {
        await loadSpotifySdk();
        return new Promise((resolve, reject) => {
          const p = new g.Spotify.Player({
            name: 'EQ Player',
            volume: 1,
            getOAuthToken: (cb) => spotifyToken().then(cb, () => cb(''))
          });
          sp.player = p;
          const fail = (code, msg) => reject(new StreamError(code, msg));
          p.addListener('ready', ({ device_id }) => { sp.deviceId = device_id; resolve(); });
          p.addListener('not_ready', () => { sp.deviceId = null; });
          p.addListener('player_state_changed', onSpotifyState);
          p.addListener('initialization_error', ({ message }) => fail('init', 'Spotify player could not start: ' + message));
          p.addListener('authentication_error', () => fail('auth', 'Spotify sign-in expired. Reconnect Spotify in Settings.'));
          p.addListener('account_error', () => fail('premium_required', 'Spotify Premium is required to stream this track.'));
          p.addListener('playback_error', ({ message }) => emit('error', new StreamError('playback', 'Spotify playback error: ' + message)));
          p.connect();
        });
      })().catch((err) => { sp.ready = null; sp.player = null; sp.deviceId = null; throw err; });
    }
    return sp.ready;
  }

  async function spotifyPlay(track, positionSec) {
    await spotifyPlayer();
    const tok = await spotifyToken();
    const r = await fetch(SPOTIFY_API + '/me/player/play?device_id=' + encodeURIComponent(sp.deviceId), {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [track.uri], position_ms: Math.round((positionSec || 0) * 1000) })
    });
    if (r.status === 401) throw new StreamError('auth', 'Spotify sign-in expired. Reconnect Spotify in Settings.');
    if (r.status === 403) throw new StreamError('premium_required', 'Spotify Premium is required to stream this track.');
    if (r.status === 404) throw new StreamError('no_device', 'Spotify could not reach the EQ Player device. Try again.');
    if (!r.ok && r.status !== 204) throw new StreamError('api', 'Spotify playback failed (' + r.status + ').');
  }

  /* ================= Apple Music (MusicKit JS v3) ================= */
  let am = null;
  let amReady = null;

  // one in-flight load shared by every caller; a failed load can be retried
  let musickitLoading = null;
  function loadMusicKit() {
    if (g.MusicKit) return Promise.resolve();
    if (musickitLoading) return musickitLoading;
    musickitLoading = new Promise((resolve, reject) => {
      const onLoaded = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        document.removeEventListener('musickitloaded', onLoaded);
        reject(new StreamError('sdk_unavailable', 'MusicKit did not load.'));
      }, 15000);
      document.addEventListener('musickitloaded', onLoaded, { once: true });
      const s = document.createElement('script');
      s.src = MUSICKIT_URL;
      s.async = true;
      s.onerror = () => { clearTimeout(timer); document.removeEventListener('musickitloaded', onLoaded); reject(new StreamError('sdk_unavailable', 'Could not load Apple MusicKit.')); };
      document.head.appendChild(s);
    }).catch((e) => { musickitLoading = null; throw e; });
    return musickitLoading;
  }

  function onAppleState() {
    if (!am) return;
    const K = g.MusicKit.PlaybackStates || {};
    const st = am.playbackState;
    emit('state', {
      source: 'apple_music',
      uri: am.nowPlayingItem && am.nowPlayingItem.id,
      paused: st !== K.playing,
      position: am.currentPlaybackTime || 0,
      duration: am.currentPlaybackDuration || 0,
      ts: Date.now(),
      ended: K.ended != null && st === K.ended
    });
  }

  async function appleInstance() {
    if (!appleConfigured()) throw new StreamError('not_configured', 'Enter your Apple Music developer token in Settings first.');
    if (am) return am;
    if (!amReady) {
      amReady = loadMusicKit().then(() => {
        g.MusicKit.configure({
          developerToken: CFG.VITE_APPLE_MUSIC_DEVELOPER_TOKEN,
          app: { name: 'EQ Player', build: '1.0.0' }
        });
        am = g.MusicKit.getInstance();
        const K = g.MusicKit.Events;
        am.addEventListener(K.playbackStateDidChange, onAppleState);
        am.addEventListener(K.playbackTimeDidChange, onAppleState);
        return am;
      }).catch((err) => { amReady = null; throw err; });
    }
    return amReady;
  }

  async function appleConnect() {
    const mk = await appleInstance();
    await mk.authorize();
    const a = readAuth();
    a.apple = { connected: true };
    writeAuth(a);
    return true;
  }

  function appleRecord(s) {
    const a = s.attributes || {};
    const art = a.artwork && a.artwork.url ? a.artwork.url.replace('{w}', '300').replace('{h}', '300') : '';
    return {
      source: 'apple_music',
      ext: s.id,
      name: 'apple:' + s.id,
      title: a.name || 'Untitled',
      artist: a.artistName || '',
      album: a.albumName || '',
      duration: (a.durationInMillis || 0) / 1000,
      art,
      size: 0,
      added: Date.now(),
      fmt: 'Apple Music'
    };
  }

  async function appleImport(opts) {
    const onProgress = (opts && opts.onProgress) || (() => {});
    const mk = await appleInstance();
    if (!mk.isAuthorized) await mk.authorize();
    const lists = [];
    let next = '/v1/me/library/playlists?limit=100';
    while (next) {
      const j = await mk.api.music(next);
      (j.data || []).forEach((p) => lists.push(p));
      next = j.next || null;
    }
    const records = [];
    const seen = new Set();
    for (let i = 0; i < lists.length; i++) {
      const p = lists[i];
      onProgress('Playlist ' + (i + 1) + ' of ' + lists.length + ': ' + ((p.attributes && p.attributes.name) || ''));
      let n = '/v1/me/library/playlists/' + p.id + '/tracks?limit=100';
      while (n) {
        const j = await mk.api.music(n);
        for (const s of j.data || []) {
          if (s.type !== 'library-songs' && s.type !== 'songs') continue;
          if (seen.has(s.id)) continue;
          seen.add(s.id);
          records.push(appleRecord(s));
        }
        n = j.next || null;
      }
    }
    return { records, skipped: 0, playlists: lists.length };
  }

  async function applePlay(track, positionSec) {
    const mk = await appleInstance();
    if (!mk.isAuthorized) await mk.authorize();
    try {
      await mk.setQueue({ songs: [track.ext] });
      await mk.play();
      if (positionSec) await mk.seekToTime(positionSec);
    } catch (err) {
      // only a real subscription problem is reported as one; anything else is a playback failure
      const msg = String((err && (err.message || err.name)) || '');
      if (/subscri|not authori|authoriz|forbidden|403/i.test(msg)) throw new StreamError('subscription_required', 'Apple Music could not play this track. An active subscription is required.');
      throw new StreamError('play_failed', 'Apple Music could not start this track. ' + (msg || 'Try again.'));
    }
  }

  /* ================= facade ================= */
  const api = {
    on,
    StreamError,
    status() {
      const a = readAuth();
      return {
        spotify: { configured: spotifyConfigured(), connected: !!(a.spotify && a.spotify.refresh) },
        apple: { configured: appleConfigured(), connected: !!(a.apple && a.apple.connected) }
      };
    },
    spotifyLogin,
    handleRedirect,
    appleConnect,
    disconnect(provider) {
      const a = readAuth();
      if (provider === 'spotify') {
        delete a.spotify;
        if (sp.player) { try { sp.player.disconnect(); } catch (e) { /* ignore */ } }
        sp.player = null; sp.deviceId = null; sp.ready = null;
      } else if (provider === 'apple') {
        delete a.apple;
        if (am && am.unauthorize) { try { am.unauthorize(); } catch (e) { /* ignore */ } }
      }
      writeAuth(a);
    },
    importLibrary(provider, opts) {
      return provider === 'spotify' ? spotifyImport(opts) : appleImport(opts);
    },
    play(track, positionSec) {
      if (track.source === 'spotify') return spotifyPlay(track, positionSec);
      if (track.source === 'apple_music') return applePlay(track, positionSec);
      return Promise.reject(new StreamError('unknown', 'Unknown streaming source.'));
    },
    pause(source) {
      if (source === 'spotify' && sp.player) return sp.player.pause();
      if (source === 'apple_music' && am) return am.pause();
    },
    resume(source) {
      if (source === 'spotify' && sp.player) return sp.player.resume();
      if (source === 'apple_music' && am) return am.play();
    },
    seek(source, sec) {
      if (source === 'spotify' && sp.player) return sp.player.seek(Math.round(sec * 1000));
      if (source === 'apple_music' && am) return am.seekToTime(sec);
    },
    setVolume(v) { if (sp.player) sp.player.setVolume(v); },
    stop(source) { return api.pause(source); }
  };

  g.StreamingProviders = api;
})(typeof window !== 'undefined' ? window : globalThis);
