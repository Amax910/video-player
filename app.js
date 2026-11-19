'use strict';

/* =====================================================================
   Frame Player — plays YouTube, video links, webpages (via bookmarklet)
   and local files in one player with zoom/pan, speed, A-B loop,
   frame stepping and aspect control. No build step, no backend.
   ===================================================================== */

const HLS_JS = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.20/hls.min.js';
const FILE_RE = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|mp3|m4a|aac|wav|flac|opus)$/i;
const HLS_RE = /\.m3u8$/i;
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const FPS_LIST = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
const ZOOM_MIN = 0.25, ZOOM_MAX = 12;
const TYPE_LABEL = { youtube: 'YouTube', hls: 'Stream', file: 'Video', local: 'File' };

/* ---------------- helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const store = {
  get(k, d) { try { const v = localStorage.getItem('frame.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('frame.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function fmt(t, dec = 0) {
  if (!isFinite(t) || t < 0) t = 0;
  const p = 10 ** dec;
  t = Math.floor(t * p) / p;
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  const ss = dec ? s.toFixed(dec).padStart(3 + dec, '0') : String(Math.floor(s)).padStart(2, '0');
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + ss;
}
const fmtRate = r => +r.toFixed(2) + '×';
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
function snapFps(f) {
  let best = FPS_LIST[0];
  for (const c of FPS_LIST) if (Math.abs(c - f) < Math.abs(best - f)) best = c;
  return Math.abs(best - f) / best < 0.03 ? best : Math.round(f);
}
function parseRatio(s) {
  s = String(s || '').trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/i);
  const r = m ? +m[1] / +m[2] : +s;
  return r > 0.1 && r < 10 ? r : null;
}
function shortUrl(u) {
  try { const x = new URL(u); const s = x.hostname.replace(/^www\./, '') + x.pathname; return s.length > 70 ? s.slice(0, 67) + '…' : s; }
  catch { return String(u).slice(0, 70); }
}
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}
function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
}

/* ---------------- link parsing ---------------- */
function parseYtTime(t) {
  if (!t) return 0;
  if (/^\d+(\.\d+)?s?$/.test(t)) return parseFloat(t);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}
function parseYouTube(u) {
  let url;
  try { url = new URL(u); } catch { return null; }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id = null, shorts = false;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(embed|shorts|live|v)\/([\w-]{11})/);
      if (m) { id = m[2]; shorts = m[1] === 'shorts'; }
    }
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  return { id, shorts, start: parseYtTime(url.searchParams.get('t') || url.searchParams.get('start')) };
}
/** Work out how to play a URL. hint 'v' = it came from a <video> tag, so treat it as a file. */
function classify(u, hint) {
  if (typeof u !== 'string') return null;
  const yt = parseYouTube(u);
  if (yt) return { type: 'youtube', ...yt, label: u };
  let url;
  try { url = new URL(u); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (HLS_RE.test(url.pathname)) return { type: 'hls', url: u, label: u };
  if (FILE_RE.test(url.pathname) || hint === 'v') return { type: 'file', url: u, label: u };
  return null;
}
function toCandidates(list) {
  const seen = new Set(), out = [];
  for (const [u, hint] of list) {
    const c = classify(u, hint);
    if (!c) continue;
    const key = c.type === 'youtube' ? 'yt:' + c.id : c.url;
    if (seen.has(key)) continue;
    seen.add(key); out.push(c);
    if (out.length >= 25) break;
  }
  return out;
}
function extractFromHtml(html, base) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const found = [];
  const add = (u, hint) => {
    if (!u) return;
    try { found.push([new URL(u.trim().replace(/&amp;/g, '&'), base).href, hint]); } catch { /* bad url */ }
  };
  doc.querySelectorAll('video[src], video source[src]').forEach(e => add(e.getAttribute('src'), 'v'));
  doc.querySelectorAll('meta[property^="og:video"], meta[name="twitter:player:stream"], meta[itemprop="contentUrl"], meta[itemprop="embedUrl"]')
    .forEach(m => add(m.getAttribute('content')));
  doc.querySelectorAll('iframe[src]').forEach(f => add(f.getAttribute('src')));
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 6) return;
    if (Array.isArray(o)) return o.forEach(x => walk(x, depth + 1));
    if (typeof o.contentUrl === 'string') add(o.contentUrl, 'v');
    if (typeof o.embedUrl === 'string') add(o.embedUrl);
    Object.values(o).forEach(v => walk(v, depth + 1));
  };
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s => { try { walk(JSON.parse(s.textContent)); } catch { /* bad json */ } });
  const re = /https?:\\?\/\\?\/[^\s"'<>]+?\.(?:m3u8|mp4|webm)(?:\?[^\s"'<>]*)?/gi;
  for (const m of html.matchAll(re)) add(m[0].replace(/\\\//g, '/'));
  return toCandidates(found);
}

/* =====================================================================
   Adapters: one interface over <video> and the YouTube iframe
   ===================================================================== */
class Adapter {
  constructor(emit) {
    this.ready = false; this.dead = false; this.fps = null;
    this.emit = (...a) => { if (!this.dead) emit(...a); };
    this.whenReady = new Promise((res, rej) => { this._ok = res; this._fail = rej; });
    this.whenReady.catch(() => {});
  }
  markReady() { if (this.ready || this.dead) return; this.ready = true; this._ok(); this.emit('ready'); }
  fail(msg) { if (this.dead) return; if (!this.ready) this._fail(new Error(msg)); else this.emit('error', msg); }
}

function mediaErrorText(err, src) {
  const code = err ? err.code : 0;
  if (src.type === 'local') return code === 3
    ? 'This file is damaged or uses a codec this browser can\'t decode.'
    : 'This browser can\'t play this file\'s format. MP4 (H.264) and WebM play everywhere.';
  if (code === 2) return 'Network error while loading the video.';
  if (code === 3) return 'The video could not be decoded.';
  return 'Couldn\'t play this link. It may not be a video, the format may not be supported, or the site may block its videos from playing on other sites.';
}

class Html5Adapter extends Adapter {
  constructor(box, src, emit) {
    super(emit);
    this.kind = 'html5'; this.src = src;
    const v = this.v = el('video', 'media');
    v.playsInline = true; v.preload = 'auto';
    box.appendChild(v);
    const on = (n, f) => v.addEventListener(n, f);
    on('loadedmetadata', () => this.markReady());
    ['play', 'pause', 'playing', 'waiting', 'canplay'].forEach(n => on(n, () => this.emit('state')));
    on('ended', () => this.emit('ended'));
    on('ratechange', () => this.emit('rate'));
    on('resize', () => this.emit('resize'));
    on('error', () => this.fail(mediaErrorText(v.error, src)));
    on('seeking', () => { this.fpsLast = null; });
    this.probeFps();
  }
  async load() {
    const { url, type } = this.src;
    if (type === 'hls' && !this.v.canPlayType('application/vnd.apple.mpegurl')) {
      await loadScript(HLS_JS).catch(() => { throw new Error('Could not load the stream player. Check your connection.'); });
      if (this.dead) return;
      if (!window.Hls || !Hls.isSupported()) throw new Error('This browser can\'t play HLS streams.');
      const hls = this.hls = new Hls({ enableWorker: true });
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal) this.fail('Stream error (' + (d.details || d.type) + '). The site may block its streams from playing on other sites.');
      });
      hls.loadSource(url);
      hls.attachMedia(this.v);
    } else {
      this.v.src = url;
    }
  }
  /** Measure the real frame rate from presented frames (Chromium/Safari). */
  probeFps() {
    const v = this.v;
    if (!('requestVideoFrameCallback' in v)) return;
    const diffs = [];
    const cb = (_, md) => {
      if (this.dead) return;
      const last = this.fpsLast;
      if (last && !v.paused && v.playbackRate <= 1.01) {
        const dt = md.mediaTime - last.t, df = md.presentedFrames - last.f;
        if (dt > 0 && df > 0 && dt / df < 0.2) {
          diffs.push(dt / df);
          if (diffs.length > 40) diffs.shift();
          if (diffs.length >= 12) {
            const f = snapFps(1 / median(diffs));
            if (f !== this.fps) { this.fps = f; this.emit('fps'); }
          }
        }
      }
      this.fpsLast = { t: md.mediaTime, f: md.presentedFrames };
      v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  }
  play() { const p = this.v.play(); if (p) p.catch(() => {}); }
  pause() { this.v.pause(); }
  get paused() { return this.v.paused; }
  get waiting() { return !this.v.paused && this.v.readyState < 3; }
  get time() { return this.v.currentTime; }
  seek(t) { this.v.currentTime = Math.max(0, this.duration ? Math.min(t, this.duration) : t); }
  get duration() { const d = this.v.duration; return isFinite(d) ? d : 0; }
  get bufferedEnd() {
    const b = this.v.buffered, t = this.v.currentTime;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= t) return b.end(i);
    return 0;
  }
  get rate() { return this.v.playbackRate; }
  setRate(r) { this.v.playbackRate = r; }
  get minRate() { return 0.1; }
  get maxRate() { return 4; }
  setVolume(x) { this.v.volume = x; }
  setMuted(m) { this.v.muted = m; }
  setLoop(l) { this.v.loop = l; }
  get natural() { const v = this.v; return v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9; }
  get canPip() { return !!document.pictureInPictureEnabled && this.v.videoWidth > 0; }
  pip() { return document.pictureInPictureElement ? document.exitPictureInPicture() : this.v.requestPictureInPicture(); }
  get title() { return ''; }
  destroy() {
    this.dead = true;
    try { if (this.hls) this.hls.destroy(); } catch { /* ignore */ }
    const v = this.v;
    v.pause(); v.removeAttribute('src');
    try { v.load(); } catch { /* ignore */ }
    v.remove();
    if (this.src.revoke) URL.revokeObjectURL(this.src.url);
  }
}

let ytApi = null;
function loadYouTubeApi() {
  if (window.YT && YT.Player) return Promise.resolve();
  if (!ytApi) {
    ytApi = new Promise((res, rej) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); res(); };
      loadScript('https://www.youtube.com/iframe_api').catch(() => { ytApi = null; rej(new Error('Couldn\'t load YouTube. Check your connection.')); });
    });
  }
  return ytApi;
}
function ytErrorText(c) {
  if (c === 101 || c === 150) return 'The owner of this video doesn\'t allow it to be played outside YouTube.';
  if (c === 100) return 'This video wasn\'t found. It may be private or deleted.';
  if (c === 2) return 'That YouTube link looks invalid.';
  if (c === 153) return 'YouTube refused to load here. Open the player from its web address, not as a file on disk.';
  return 'YouTube couldn\'t play this video (error ' + c + ').';
}

class YouTubeAdapter extends Adapter {
  constructor(box, src, emit) {
    super(emit);
    this.kind = 'youtube'; this.src = src; this.state = -1;
    const p = new URLSearchParams({ enablejsapi: 1, controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0, autoplay: 1 });
    if (location.origin && location.origin !== 'null') p.set('origin', location.origin);
    if (src.start) p.set('start', Math.floor(src.start));
    const f = this.f = el('iframe', 'media');
    f.title = 'YouTube video';
    f.referrerPolicy = 'strict-origin-when-cross-origin'; // YouTube needs to see our origin
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.src = `https://www.youtube.com/embed/${encodeURIComponent(src.id)}?${p}`;
    box.appendChild(f);
  }
  async load() {
    await loadYouTubeApi();
    if (this.dead) return;
    this.p = new YT.Player(this.f, {
      events: {
        onReady: () => this.markReady(),
        onStateChange: e => { this.state = e.data; this.emit('state'); if (e.data === 0) this.emit('ended'); },
        onPlaybackRateChange: () => this.emit('rate'),
        onError: e => this.fail(ytErrorText(e.data)),
      },
    });
  }
  get api() { return this.p && typeof this.p.getCurrentTime === 'function' ? this.p : null; }
  play() { const p = this.api; if (p) p.playVideo(); }
  pause() { const p = this.api; if (p) p.pauseVideo(); }
  get paused() { return this.state !== 1 && this.state !== 3; }
  get waiting() { return this.state === 3; }
  get time() {
    const p = this.api;
    if (!p) return 0;
    const c = p.getCurrentTime() || 0;
    // YouTube reports the old time for a moment after a seek; report the target until it catches up.
    if (this.pend) {
      if (Math.abs(c - this.pend.t) < 0.2 || performance.now() - this.pend.at > 1500) this.pend = null;
      else return this.pend.t;
    }
    return c;
  }
  seek(t) {
    const p = this.api;
    if (!p) return;
    t = Math.max(0, this.duration ? Math.min(t, this.duration) : t);
    this.pend = { t, at: performance.now() };
    p.seekTo(t, true);
  }
  get duration() { const p = this.api; return p ? p.getDuration() || 0 : 0; }
  get bufferedEnd() { const p = this.api; return p ? (p.getVideoLoadedFraction() || 0) * this.duration : 0; }
  get rate() { const p = this.api; return p ? p.getPlaybackRate() || 1 : 1; }
  setRate(r) { const p = this.api; if (p) p.setPlaybackRate(r); }
  get minRate() { return 0.25; }
  get maxRate() { return 2; }
  setVolume(x) { const p = this.api; if (p) p.setVolume(Math.round(x * 100)); }
  setMuted(m) { const p = this.api; if (p) { if (m) p.mute(); else p.unMute(); } }
  setLoop() { /* handled on 'ended' */ }
  get natural() { return this.src.shorts ? 9 / 16 : 16 / 9; }
  get canPip() { return false; }
  get title() { try { const p = this.api; return (p && p.getVideoData && p.getVideoData().title) || ''; } catch { return ''; } }
  destroy() {
    this.dead = true;
    try { if (this.p && this.p.destroy) this.p.destroy(); } catch { /* ignore */ }
    this.f.remove();
  }
}

/* =====================================================================
   App
   ===================================================================== */
const els = {
  player: $('#player'), stage: $('#stage'), layer: $('#layer'), box: $('#box'), hit: $('#hit'),
  osd: $('#osd'), msg: $('#msg'),
  form: $('#openForm'), url: $('#urlInput'), fileBtn: $('#fileBtn'), fileInput: $('#fileInput'),
  bmBtn: $('#bmBtn'), adv: $('#advToggle'), now: $('#now'),
  seek: $('#seek'), track: $('#seek .track'), buf: $('#seek .buf'), prog: $('#seek .prog'), abBar: $('#seek .ab'),
  mkA: $('#seek .mk[data-k=a]'), mkB: $('#seek .mk[data-k=b]'), tip: $('#seek .tip'),
  play: $('#playBtn'), back: $('#backBtn'), fwd: $('#fwdBtn'), mute: $('#muteBtn'), vol: $('#volRange'),
  tCur: $('#tCur'), tDur: $('#tDur'),
  zoomOut: $('#zoomOut'), zoomIn: $('#zoomIn'), zoomVal: $('#zoomVal'),
  speedBtn: $('#speedBtn'), speedPop: $('#speedPop'), speedRange: $('#speedRange'), speedVal: $('#speedVal'), speedChips: $('#speedChips'),
  loop: $('#loopBtn'), pip: $('#pipBtn'), help: $('#helpBtn'), fs: $('#fsBtn'),
  fBack: $('#fBack'), fFwd: $('#fFwd'), frameNo: $('#frameNo'), fps: $('#fpsSel'),
  aBtn: $('#aBtn'), bBtn: $('#bBtn'), abLoop: $('#abLoopBtn'), abClear: $('#abClear'),
  aspect: $('#aspectSel'), aspectCustom: $('#aspectCustom'),
  helpDlg: $('#helpDlg'), bmDlg: $('#bmDlg'), bmLink: $('#bmLink'),
};

const S = {
  adapter: null,
  zoom: 1, tx: 0, ty: 0, box: { w: 0, h: 0, W: 0, H: 0 },
  advanced: !!store.get('advanced', false),
  aspect: store.get('aspect', 'original'),
  customAspect: store.get('customAspect', '1.85:1'),
  fpsChoice: String(store.get('fps', 'auto')),
  a: null, b: null, abLoop: true,
  rate: 1, volume: clamp(+store.get('volume', 1) || 0, 0, 1), muted: !!store.get('muted', false), loop: false,
  scrub: null,
};

/* ---------------- messages ---------------- */
function showMsg(node) {
  els.msg.replaceChildren(...(node ? [node] : []));
  els.msg.classList.toggle('show', !!node);
}
function showEmpty() {
  const c = el('div', 'card empty');
  c.append(el('h2', null, 'Nothing playing'));
  const ul = el('ul');
  const li = (b, t) => { const x = el('li'); x.append(el('b', null, b), ' ' + t); ul.append(x); };
  li('Paste', 'a YouTube link, a video link or a webpage in the box above');
  li('Drop', 'a video file anywhere on this window, or click Open file');
  li('Bookmarklet', 'to send the video from any page you\'re on');
  c.append(ul);
  showMsg(c);
}
function showError(text, actions = []) {
  const c = el('div', 'card');
  c.append(el('h2', null, 'Can\'t play this'), el('p', 'err', text));
  if (actions.length) {
    const row = el('div', 'actions');
    for (const [label, fn, primary] of actions) {
      const b = el('button', 'btn' + (primary ? ' primary' : ''), label);
      b.type = 'button'; b.onclick = fn; row.append(b);
    }
    c.append(row);
  }
  showMsg(c);
}
function showChooser(cands, title) {
  const c = el('div', 'card');
  c.append(el('h2', null, cands.length + ' videos found'));
  if (title) c.append(el('p', null, title));
  const list = el('div', 'list');
  for (const cand of cands) {
    const b = el('button', 'cand');
    b.type = 'button'; b.title = cand.label;
    b.append(el('span', 'tag ' + cand.type, TYPE_LABEL[cand.type]), el('span', 'u', shortUrl(cand.label)));
    b.onclick = () => load({ ...cand, title });
    list.append(b);
  }
  c.append(list);
  showMsg(c);
}
let osdTimer;
function osd(text) {
  els.osd.textContent = text;
  els.osd.classList.add('show');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => els.osd.classList.remove('show'), 900);
}
function setLoading(on) { els.stage.classList.toggle('loading', on); }
function setTitle(t) {
  els.now.textContent = t || '';
  document.title = t ? t + ' · Frame Player' : 'Frame Player';
}

/* ---------------- loading ---------------- */
let loadSeq = 0, openSeq = 0;

function teardown() {
  const ad = S.adapter;
  if (ad) {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    ad.destroy();
  }
  S.adapter = null;
  els.box.replaceChildren();
  document.body.classList.add('no-media');
  document.body.classList.remove('has-media', 'playing');
  els.stage.classList.remove('buffering');
  setTitle('');
}

/** Load a source. Resolves true when it's playing, false on failure. `quiet` = probe, no error card. */
async function load(src, { quiet = false } = {}) {
  const seq = ++loadSeq;
  teardown();
  showMsg(null);
  setLoading(true);
  if (src.type === 'youtube' && location.protocol === 'file:') {
    setLoading(false);
    showError(ytErrorText(153));
    return false;
  }
  const emit = (ev, data) => { if (seq === loadSeq) onAdapter(ev, data); };
  const ad = src.type === 'youtube' ? new YouTubeAdapter(els.box, src, emit) : new Html5Adapter(els.box, src, emit);
  S.adapter = ad;
  S.a = S.b = null;
  S.zoom = 1; S.tx = S.ty = 0;
  try {
    await ad.load();
    await withTimeout(ad.whenReady, quiet ? 8000 : 30000, 'The video took too long to start loading.');
  } catch (e) {
    if (seq !== loadSeq) return false;
    teardown();
    setLoading(false);
    if (!quiet) {
      const actions = src.type === 'youtube'
        ? [['Open on YouTube', () => window.open('https://www.youtube.com/watch?v=' + src.id, '_blank', 'noopener')]]
        : [];
      showError(e.message || String(e), actions);
    }
    return false;
  }
  if (seq !== loadSeq) return false;
  setLoading(false);
  document.body.classList.remove('no-media');
  document.body.classList.add('has-media');
  ad.setVolume(S.volume);
  ad.setMuted(S.muted);
  ad.setLoop(S.loop);
  setRate(clamp(S.rate, ad.minRate, ad.maxRate), true);
  setTitle(ad.title || src.title || (src.type === 'local' ? src.label : shortUrl(src.label)));
  els.pip.hidden = !ad.canPip;
  layout(); updateABUI(); updateFpsUI(); updateSpeedUI();
  ad.play();
  return true;
}

function openLocal(file) {
  ++openSeq;
  load({ type: 'local', url: URL.createObjectURL(file), revoke: true, label: file.name, title: file.name });
}

async function openUrl(raw) {
  const my = ++openSeq;
  let u = String(raw || '').trim();
  if (!u) return;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u) && /^[\w-]+(\.[\w-]+)+/.test(u)) u = 'https://' + u;
  const direct = classify(u);
  if (direct) return load(direct);
  let url;
  try { url = new URL(u); } catch { return showError('That doesn\'t look like a link.'); }
  if (!/^https?:$/.test(url.protocol)) return showError('Only http and https links can be played.');

  // Unknown kind of link: first see if it's a video without a file extension…
  if (await load({ type: 'file', url: u, label: u }, { quiet: true })) return;
  if (my !== openSeq) return;
  // …then try to read it as a webpage and find the videos in it.
  setLoading(true);
  const cands = await scanPage(u);
  if (my !== openSeq) return;
  setLoading(false);
  if (cands === null) {
    showError('This site doesn\'t let other websites read its pages, so the player can\'t look inside it. Open the page in your browser and click the Send to Frame bookmarklet instead.',
      [['Get the bookmarklet', openBookmarkletDialog, true], ['Open the page', () => window.open(u, '_blank', 'noopener')]]);
  } else openCandidates(cands);
}

async function scanPage(u) {
  let res;
  try { res = await fetch(u, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' }); }
  catch { return null; }
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') || '';
  if (/mpegurl/i.test(ct)) return [{ type: 'hls', url: u, label: u }];
  if (/^(video|audio)\//i.test(ct)) return [{ type: 'file', url: u, label: u }];
  if (!/html|xml|text/i.test(ct)) return [];
  return extractFromHtml(await res.text(), res.url || u);
}

function openCandidates(cands, title) {
  if (!cands.length) return showError('No playable video was found on that page. If the video loads only after you press play, start it on the page first, then use the bookmarklet.',
    [['Get the bookmarklet', openBookmarkletDialog]]);
  if (cands.length === 1) return load({ ...cands[0], title });
  showChooser(cands, title);
}

function onAdapter(ev, data) {
  const ad = S.adapter;
  if (!ad) return;
  switch (ev) {
    case 'state':
      if (ad.kind === 'youtube' && ad.title && els.now.textContent !== ad.title) setTitle(ad.title);
      poke();
      break;
    case 'ended':
      if (abActive()) { ad.seek(S.a); ad.play(); }
      else if (S.loop && ad.kind === 'youtube') { ad.seek(0); ad.play(); }
      break;
    case 'rate':
      S.rate = ad.rate; updateSpeedUI();
      break;
    case 'resize':
      els.pip.hidden = !ad.canPip;
      layout();
      break;
    case 'fps':
      updateFpsUI();
      break;
    case 'error':
      if (ad.ready) showError(data);
      break;
  }
}

/* ---------------- render loop ---------------- */
function tick() {
  requestAnimationFrame(tick);
  const ad = S.adapter;
  if (!ad || !ad.ready) return;
  let t = ad.time;
  const d = ad.duration;
  if (abActive() && !ad.paused && S.scrub == null && (t >= S.b || t < S.a - 0.25)) { ad.seek(S.a); t = S.a; }
  if (S.scrub != null) t = S.scrub;
  els.prog.style.width = (d ? clamp(t / d, 0, 1) * 100 : 0) + '%';
  els.buf.style.width = (d ? clamp(ad.bufferedEnd / d, 0, 1) * 100 : 0) + '%';
  els.tCur.textContent = fmt(t, S.advanced ? 2 : 0);
  els.tDur.textContent = fmt(d);
  if (S.advanced) els.frameNo.textContent = 'Frame ' + Math.floor(t * fps() + 1e-3);
  document.body.classList.toggle('playing', !ad.paused);
  els.stage.classList.toggle('buffering', ad.waiting);
}

/* ---------------- playback ---------------- */
function togglePlay() {
  const ad = S.adapter;
  if (!ad || !ad.ready) return;
  if (ad.paused) ad.play(); else ad.pause();
}
function seekBy(dt) {
  const ad = S.adapter;
  if (!ad || !ad.ready) return;
  ad.seek(ad.time + dt);
  osd((dt > 0 ? '+' : '−') + Math.abs(dt) + ' s');
}
function setRate(r, silent) {
  const ad = S.adapter;
  const lo = ad ? ad.minRate : 0.1, hi = ad ? ad.maxRate : 4;
  r = clamp(Math.round(r * 100) / 100, lo, hi);
  S.rate = r;
  if (ad) ad.setRate(r);
  updateSpeedUI();
  if (!silent) osd('Speed ' + fmtRate(r));
}
function stepRate(dir) {
  const r = S.rate;
  const next = dir > 0 ? RATES.find(x => x > r + 0.001) : [...RATES].reverse().find(x => x < r - 0.001);
  if (next != null) setRate(next);
}
function updateSpeedUI() {
  const ad = S.adapter;
  const lo = ad ? ad.minRate : 0.1, hi = ad ? ad.maxRate : 4;
  els.speedBtn.textContent = fmtRate(S.rate);
  els.speedVal.textContent = fmtRate(S.rate);
  els.speedRange.min = lo; els.speedRange.max = hi;
  els.speedRange.value = S.rate;
  for (const b of els.speedChips.children) {
    const r = +b.dataset.r;
    b.disabled = r < lo - 1e-6 || r > hi + 1e-6;
    b.classList.toggle('cur', Math.abs(r - S.rate) < 1e-6);
  }
}
function setVolume(v) {
  S.volume = clamp(v, 0, 1);
  if (S.volume > 0) S.muted = false;
  applyVolume();
}
function toggleMute() {
  if (S.volume === 0) { S.volume = 0.5; S.muted = false; } else S.muted = !S.muted;
  applyVolume();
  osd(S.muted ? 'Muted' : 'Volume ' + Math.round(S.volume * 100) + '%');
}
function applyVolume() {
  const ad = S.adapter;
  if (ad && ad.ready) { ad.setVolume(S.volume); ad.setMuted(S.muted); }
  els.vol.value = S.muted ? 0 : S.volume;
  document.body.classList.toggle('muted', S.muted || S.volume === 0);
  store.set('volume', S.volume); store.set('muted', S.muted);
}
function toggleLoop() {
  S.loop = !S.loop;
  if (S.adapter) S.adapter.setLoop(S.loop);
  els.loop.classList.toggle('on', S.loop);
  els.loop.setAttribute('aria-pressed', S.loop);
  osd(S.loop ? 'Loop on' : 'Loop off');
}
function toggleFs() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (els.player.requestFullscreen) els.player.requestFullscreen().catch(() => {});
}
function togglePip() {
  const ad = S.adapter;
  if (ad && ad.canPip) ad.pip().catch(() => {});
}

/* ---------------- layout, zoom & pan ---------------- */
function effectiveAspect() { return S.advanced ? S.aspect : 'original'; }

/**
 * The media element is always laid out at the video's own shape (so a YouTube iframe never
 * letterboxes itself), then scaled horizontally to the chosen display shape. Zoom and pan are
 * a separate transform on the layer around it.
 */
function layout() {
  const W = els.stage.clientWidth, H = els.stage.clientHeight;
  if (!W || !H) return;
  const ad = S.adapter;
  const A = ad ? ad.natural : 16 / 9;
  const mode = effectiveAspect();
  let D = A, cover = false;
  if (mode === 'fill') cover = true;
  else if (mode === 'stretch') D = W / H;
  else if (mode === 'custom') D = parseRatio(S.customAspect) || A;
  else if (mode !== 'original') D = parseRatio(mode) || A;
  let w, h;
  if ((W / H > D) !== cover) { h = H; w = H * D; } else { w = W; h = W / D; }
  S.box = { w, h, W, H };
  const mw = h * A;
  els.box.style.width = mw + 'px';
  els.box.style.height = h + 'px';
  els.box.style.transform = `translate(-50%, -50%) scale(${w / mw}, 1)`;
  clampPan();
  applyView();
}
function clampPan() {
  const { w, h, W, H } = S.box;
  const mx = Math.max(0, (w * S.zoom - W) / 2), my = Math.max(0, (h * S.zoom - H) / 2);
  S.tx = clamp(S.tx, -mx, mx);
  S.ty = clamp(S.ty, -my, my);
}
function applyView() {
  els.layer.style.transform = `translate(${S.tx}px, ${S.ty}px) scale(${S.zoom})`;
  els.zoomVal.textContent = Math.round(S.zoom * 100) + '%';
  const { w, h, W, H } = S.box;
  els.stage.classList.toggle('zoomed', w * S.zoom > W + 1 || h * S.zoom > H + 1);
}
/** Zoom to z, keeping the point (px, py) — relative to the stage centre — fixed on screen. */
function zoomAt(z, px = 0, py = 0, show = true) {
  z = clamp(z, ZOOM_MIN, ZOOM_MAX);
  const k = z / S.zoom;
  S.tx = px - k * (px - S.tx);
  S.ty = py - k * (py - S.ty);
  S.zoom = z;
  clampPan(); applyView();
  if (show) osd('Zoom ' + Math.round(z * 100) + '%');
}
function panBy(dx, dy) { S.tx += dx; S.ty += dy; clampPan(); applyView(); }
function resetView() { S.zoom = 1; S.tx = S.ty = 0; clampPan(); applyView(); osd('Zoom 100%'); }
function stagePoint(x, y) {
  const r = els.stage.getBoundingClientRect();
  return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 };
}

els.stage.addEventListener('wheel', e => {
  if (!S.adapter) return;
  e.preventDefault();
  const p = stagePoint(e.clientX, e.clientY);
  const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
  zoomAt(S.zoom * Math.exp(-dy * 0.0015), p.x, p.y);
}, { passive: false });

// Click = play/pause, drag = pan, two fingers = pinch-zoom.
const ptrs = new Map();
let gesture = null;
els.hit.addEventListener('pointerdown', e => {
  if (!S.adapter || (e.pointerType === 'mouse' && e.button !== 0)) return;
  els.hit.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) {
    gesture = { kind: 'tap', sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY };
  } else if (ptrs.size === 2) {
    const [p1, p2] = [...ptrs.values()];
    gesture = {
      kind: 'pinch', d0: Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1, z0: S.zoom,
      mid: stagePoint((p1.x + p2.x) / 2, (p1.y + p2.y) / 2), tx0: S.tx, ty0: S.ty,
    };
  }
});
els.hit.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId) || !gesture) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gesture.kind === 'pinch' && ptrs.size >= 2) {
    const [p1, p2] = [...ptrs.values()];
    const g = gesture;
    const z = clamp(g.z0 * Math.hypot(p2.x - p1.x, p2.y - p1.y) / g.d0, ZOOM_MIN, ZOOM_MAX);
    const mid = stagePoint((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
    const k = z / g.z0;
    S.zoom = z;
    S.tx = mid.x - k * (g.mid.x - g.tx0);
    S.ty = mid.y - k * (g.mid.y - g.ty0);
    clampPan(); applyView();
    return;
  }
  if (gesture.kind === 'tap' && Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > 5) {
    gesture.kind = 'pan';
    els.stage.classList.add('dragging');
  }
  if (gesture.kind === 'pan') {
    panBy(e.clientX - gesture.lx, e.clientY - gesture.ly);
    gesture.lx = e.clientX; gesture.ly = e.clientY;
  }
});
function endPointer(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (gesture && gesture.kind === 'tap' && e.type === 'pointerup' && ptrs.size === 0) togglePlay();
  if (ptrs.size === 0) { gesture = null; els.stage.classList.remove('dragging'); }
  else if (ptrs.size === 1) {
    const [p] = [...ptrs.values()];
    gesture = { kind: 'pan', sx: p.x, sy: p.y, lx: p.x, ly: p.y };
  }
}
els.hit.addEventListener('pointerup', endPointer);
els.hit.addEventListener('pointercancel', endPointer);
els.hit.addEventListener('dblclick', toggleFs);

/* ---------------- seek bar & A-B markers ---------------- */
function timeAt(clientX) {
  const r = els.track.getBoundingClientRect();
  return clamp((clientX - r.left) / r.width, 0, 1) * (S.adapter ? S.adapter.duration : 0);
}
els.seek.addEventListener('pointerdown', e => {
  const ad = S.adapter;
  if (!ad || !ad.ready || !ad.duration || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const mk = e.target.closest('.mk');
  const mode = mk ? mk.dataset.k : 'seek';
  els.seek.setPointerCapture(e.pointerId);
  els.seek.classList.add('active');
  let lastSeek = 0;
  const move = ev => {
    const t = timeAt(ev.clientX);
    if (mode === 'seek') {
      S.scrub = t;
      const now = performance.now();
      if (ad.kind === 'html5' || now - lastSeek > 120) { ad.seek(t); lastSeek = now; }
    } else moveABPoint(mode, t);
  };
  const up = ev => {
    if (mode === 'seek' && S.scrub != null) ad.seek(S.scrub);
    S.scrub = null;
    els.seek.classList.remove('active');
    els.seek.removeEventListener('pointermove', move);
    els.seek.removeEventListener('pointerup', up);
    els.seek.removeEventListener('pointercancel', up);
    if (ev.type === 'pointerup') hoverTip(ev);
  };
  move(e);
  els.seek.addEventListener('pointermove', move);
  els.seek.addEventListener('pointerup', up);
  els.seek.addEventListener('pointercancel', up);
});
function hoverTip(e) {
  const ad = S.adapter;
  if (!ad || !ad.duration) return;
  const r = els.track.getBoundingClientRect();
  const x = clamp(e.clientX - r.left, 0, r.width);
  els.tip.style.left = x + 'px';
  els.tip.textContent = fmt(timeAt(e.clientX), S.advanced ? 1 : 0);
}
els.seek.addEventListener('pointermove', hoverTip);
els.seek.addEventListener('pointerenter', () => els.seek.classList.add('hover'));
els.seek.addEventListener('pointerleave', () => els.seek.classList.remove('hover'));

function abActive() { return S.advanced && S.abLoop && S.a != null && S.b != null && S.adapter; }
function setA() {
  const ad = S.adapter;
  if (!ad || !ad.ready) return;
  S.a = ad.time;
  if (S.b != null && S.b <= S.a + 0.05) S.b = null;
  updateABUI();
  osd('A  ' + fmt(S.a, 2));
}
function setB() {
  const ad = S.adapter;
  if (!ad || !ad.ready) return;
  const t = ad.time;
  if (S.a == null) S.a = 0;
  if (t <= S.a + 0.05) { osd('B must be after A'); return; }
  S.b = t;
  S.abLoop = true;
  updateABUI();
  osd('A-B loop  ' + fmt(S.a, 1) + ' → ' + fmt(S.b, 1));
  ad.seek(S.a);
}
function clearAB() { S.a = S.b = null; updateABUI(); osd('A-B cleared'); }
function toggleABLoop() { S.abLoop = !S.abLoop; updateABUI(); osd(S.abLoop ? 'A-B repeat on' : 'A-B repeat off'); }
function moveABPoint(k, t) {
  if (k === 'a') S.a = S.b != null ? Math.min(t, S.b - 0.05) : t;
  else S.b = Math.max(t, (S.a || 0) + 0.05);
  updateABUI();
}
function updateABUI() {
  const d = S.adapter && S.adapter.ready ? S.adapter.duration : 0;
  const pos = x => clamp(x / d, 0, 1) * 100 + '%';
  const hasA = S.a != null && d > 0, hasB = S.b != null && d > 0;
  els.mkA.classList.toggle('on', hasA);
  els.mkB.classList.toggle('on', hasB);
  if (hasA) els.mkA.style.left = pos(S.a);
  if (hasB) els.mkB.style.left = pos(S.b);
  els.abBar.classList.toggle('on', hasA && hasB);
  els.abBar.classList.toggle('off', !S.abLoop);
  if (hasA && hasB) { els.abBar.style.left = pos(S.a); els.abBar.style.width = clamp((S.b - S.a) / d, 0, 1) * 100 + '%'; }
  els.aBtn.textContent = S.a == null ? 'Set A' : 'A ' + fmt(S.a, 1);
  els.bBtn.textContent = S.b == null ? 'Set B' : 'B ' + fmt(S.b, 1);
  els.aBtn.classList.toggle('set', S.a != null);
  els.bBtn.classList.toggle('set', S.b != null);
  els.abLoop.classList.toggle('on', S.abLoop);
  els.abLoop.setAttribute('aria-pressed', S.abLoop);
}

/* ---------------- frame stepping ---------------- */
function fps() {
  if (S.fpsChoice !== 'auto') return +S.fpsChoice || 30;
  return (S.adapter && S.adapter.fps) || 30;
}
function updateFpsUI() {
  const ad = S.adapter;
  const auto = els.fps.options[0];
  if (!ad) auto.textContent = 'Auto fps';
  else if (ad.fps) auto.textContent = 'Auto · ' + (+ad.fps.toFixed(3)) + ' fps';
  else auto.textContent = ad.kind === 'html5' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype
    ? 'Auto · play to detect' : 'Auto · 30 fps (guess)';
}
function stepFrame(dir) {
  const ad = S.adapter;
  if (!ad || !ad.ready) return;
  if (!ad.paused) ad.pause();
  const f = fps();
  const cur = Math.floor(ad.time * f + 1e-3);
  const next = Math.max(0, cur + dir);
  const target = (next + 0.5) / f; // middle of the frame, so rounding never lands on its neighbour
  if (ad.duration && target > ad.duration) return;
  ad.seek(target);
  osd('Frame ' + next + (ad.kind === 'youtube' ? ' (approx.)' : ''));
}

/* ---------------- advanced switch & aspect ---------------- */
function setAdvanced(on, silent) {
  S.advanced = on;
  store.set('advanced', on);
  els.adv.checked = on;
  document.body.classList.toggle('adv', on);
  layout(); updateABUI(); updateFpsUI();
  if (!silent) osd(on ? 'Advanced on' : 'Advanced off');
}
function setAspect(v) {
  S.aspect = v;
  store.set('aspect', v);
  els.aspect.value = v;
  els.aspectCustom.hidden = v !== 'custom';
  layout();
  if (v === 'custom') els.aspectCustom.focus();
}

/* ---------------- fullscreen idle ---------------- */
let idleTimer;
function poke() {
  els.player.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (document.fullscreenElement && S.adapter && !S.adapter.paused && els.speedPop.hidden) els.player.classList.add('idle');
  }, 2500);
}
els.player.addEventListener('pointermove', poke);
els.player.addEventListener('pointerdown', poke);
document.addEventListener('fullscreenchange', () => {
  const on = document.fullscreenElement === els.player;
  els.player.classList.toggle('fs', on);
  poke();
});

/* ---------------- bookmarklet ---------------- */
// Runs on the page you're visiting: collects its video sources and opens them in this player.
function bookmarkletSource(P) {
  var c = [], seen = {};
  function a(u, k) {
    if (!u) return;
    try { u = new URL(u, location.href).href; } catch (e) { return; }
    if (/^https?:/.test(u) && !seen[u]) { seen[u] = 1; c.push([u, k || '']); }
  }
  if (/(^|\.)youtube\.com$/.test(location.hostname) && /[?&]v=|\/shorts\//.test(location.href)) a(location.href);
  // Scan this page and any frames from the same site (other sites' frames can't be read).
  function scan(w, depth) {
    var d;
    try { d = w.document; d.querySelectorAll; } catch (e) { return; }
    d.querySelectorAll('video').forEach(function (v) {
      a(v.currentSrc || v.src, 'v');
      v.querySelectorAll('source').forEach(function (s) { a(s.src, 'v'); });
    });
    d.querySelectorAll('meta[property^="og:video"],meta[name="twitter:player:stream"]').forEach(function (m) { a(m.content); });
    d.querySelectorAll('iframe').forEach(function (f) {
      if (/youtube(-nocookie)?\.com\/embed\//.test(f.src)) a(f.src);
      else if (depth < 3 && f.contentWindow) scan(f.contentWindow, depth + 1);
    });
    try {
      w.performance.getEntriesByType('resource').forEach(function (e) { if (/\.(m3u8|mp4|webm|m4v|mov)(\?|$)/i.test(e.name)) a(e.name); });
    } catch (e) { /* ignore */ }
  }
  scan(window, 0);
  if (!c.length) { alert('No playable video found on this page. If it has a play button, start the video first and try again.'); return; }
  window.open(P + '#v=' + encodeURIComponent(JSON.stringify({ p: location.href, t: document.title, c: c.slice(0, 25) })), '_blank');
}
function bookmarkletHref() {
  const player = location.href.split('#')[0];
  return 'javascript:' + encodeURIComponent('(' + bookmarkletSource.toString() + ')(' + JSON.stringify(player) + ')');
}
function openBookmarkletDialog() {
  els.bmLink.href = bookmarkletHref();
  els.bmDlg.showModal();
}
els.bmLink.addEventListener('click', e => { e.preventDefault(); osd('Drag it to your bookmarks bar'); });

function readHash() {
  const h = location.hash.slice(1);
  if (!h) return;
  const p = new URLSearchParams(h);
  if (p.has('v')) {
    let d;
    try { d = JSON.parse(p.get('v')); } catch { return showError('The link from the bookmarklet was damaged. Try again.'); }
    const list = Array.isArray(d && d.c) ? d.c.map(x => Array.isArray(x) ? [x[0], x[1]] : [x, '']) : [];
    if (typeof d.p === 'string') els.url.value = d.p;
    ++openSeq;
    openCandidates(toCandidates(list), typeof d.t === 'string' ? d.t.slice(0, 200) : '');
  } else if (p.has('src')) {
    els.url.value = p.get('src');
    openUrl(p.get('src'));
  }
}

/* ---------------- keyboard ---------------- */
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') { els.speedPop.hidden = true; return; }
  const t = e.target;
  const typing = (t.tagName === 'INPUT' && !['range', 'checkbox'].includes(t.type)) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
  if (typing || document.querySelector('dialog[open]')) return;
  const ad = S.adapter;
  const k = e.key;
  let done = true;
  poke();
  if (k === ' ' || k === 'k' || k === 'K') togglePlay();
  else if (k === 'ArrowLeft') e.shiftKey ? panBy(60, 0) : seekBy(-5);
  else if (k === 'ArrowRight') e.shiftKey ? panBy(-60, 0) : seekBy(5);
  else if (k === 'ArrowUp') e.shiftKey ? panBy(0, 60) : (setVolume((S.muted ? 0 : S.volume) + 0.05), osd('Volume ' + Math.round(S.volume * 100) + '%'));
  else if (k === 'ArrowDown') e.shiftKey ? panBy(0, -60) : (setVolume(S.volume - 0.05), osd('Volume ' + Math.round(S.volume * 100) + '%'));
  else if (k === 'j' || k === 'J') seekBy(-10);
  else if (k === 'l' || k === 'L') seekBy(10);
  else if (k === 'm' || k === 'M') toggleMute();
  else if (k === 'f' || k === 'F') toggleFs();
  else if (k === 'p' || k === 'P') togglePip();
  else if (k === '>') stepRate(1);
  else if (k === '<') stepRate(-1);
  else if (k === 'r' || k === 'R') setRate(1);
  else if (k === '+' || k === '=') zoomAt(S.zoom * 1.25);
  else if (k === '-' || k === '_') zoomAt(S.zoom / 1.25);
  else if (k === 'z' || k === 'Z') resetView();
  else if (k === 'Home') ad && ad.ready && ad.seek(0);
  else if (k === 'End') ad && ad.ready && ad.seek(ad.duration - 0.1);
  else if (/^[0-9]$/.test(k)) { if (ad && ad.ready && ad.duration) ad.seek(ad.duration * +k / 10); }
  else if (k === '?') els.helpDlg.showModal();
  else if (S.advanced && k === ',') stepFrame(-1);
  else if (S.advanced && k === '.') stepFrame(1);
  else if (S.advanced && k === '[') setA();
  else if (S.advanced && k === ']') setB();
  else if (S.advanced && k === '\\') clearAB();
  else done = false;
  if (done) e.preventDefault();
});

/* ---------------- wiring ---------------- */
els.form.addEventListener('submit', e => { e.preventDefault(); els.url.blur(); openUrl(els.url.value); });
els.fileBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => { const f = els.fileInput.files[0]; if (f) openLocal(f); els.fileInput.value = ''; });
els.bmBtn.addEventListener('click', openBookmarkletDialog);
els.adv.addEventListener('change', () => setAdvanced(els.adv.checked));

els.play.addEventListener('click', togglePlay);
els.back.addEventListener('click', () => seekBy(-10));
els.fwd.addEventListener('click', () => seekBy(10));
els.mute.addEventListener('click', toggleMute);
els.vol.addEventListener('input', () => setVolume(+els.vol.value));
els.zoomIn.addEventListener('click', () => zoomAt(S.zoom * 1.25));
els.zoomOut.addEventListener('click', () => zoomAt(S.zoom / 1.25));
els.zoomVal.addEventListener('click', resetView);
els.loop.addEventListener('click', toggleLoop);
els.pip.addEventListener('click', togglePip);
els.help.addEventListener('click', () => els.helpDlg.showModal());
els.fs.addEventListener('click', toggleFs);

els.speedBtn.addEventListener('click', e => { e.stopPropagation(); els.speedPop.hidden = !els.speedPop.hidden; });
els.speedPop.addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => { els.speedPop.hidden = true; });
els.speedRange.addEventListener('input', () => setRate(+els.speedRange.value));
for (const r of RATES) {
  const b = el('button', null, fmtRate(r));
  b.type = 'button'; b.dataset.r = r;
  b.addEventListener('click', () => setRate(r));
  els.speedChips.append(b);
}

els.fBack.addEventListener('click', () => stepFrame(-1));
els.fFwd.addEventListener('click', () => stepFrame(1));
els.fps.addEventListener('change', () => { S.fpsChoice = els.fps.value; store.set('fps', S.fpsChoice); els.fps.blur(); });
els.aBtn.addEventListener('click', setA);
els.bBtn.addEventListener('click', setB);
els.abLoop.addEventListener('click', toggleABLoop);
els.abClear.addEventListener('click', clearAB);
els.aspect.addEventListener('change', () => { setAspect(els.aspect.value); if (els.aspect.value !== 'custom') els.aspect.blur(); });
els.aspectCustom.addEventListener('change', () => {
  const ok = parseRatio(els.aspectCustom.value);
  els.aspectCustom.classList.toggle('bad', !ok);
  if (ok) { S.customAspect = els.aspectCustom.value.trim(); store.set('customAspect', S.customAspect); layout(); els.aspectCustom.blur(); }
});

// Release focus after mouse clicks so Space and arrows keep controlling the player.
document.addEventListener('pointerup', e => {
  const b = e.target.closest('button, input[type=range]');
  if (b && !b.closest('dialog') && e.pointerType !== '') setTimeout(() => b.blur(), 0);
});

// Drag & drop files or links anywhere on the window.
let dragDepth = 0;
const droppable = e => e.dataTransfer && [...e.dataTransfer.types].some(t => t === 'Files' || t === 'text/uri-list');
window.addEventListener('dragenter', e => { if (droppable(e)) { dragDepth++; document.body.classList.add('drop'); } });
window.addEventListener('dragleave', e => { if (droppable(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('drop'); } });
window.addEventListener('dragover', e => { if (droppable(e)) e.preventDefault(); });
window.addEventListener('drop', e => {
  if (!droppable(e)) return;
  e.preventDefault();
  dragDepth = 0; document.body.classList.remove('drop');
  const f = e.dataTransfer.files[0];
  if (f) return openLocal(f);
  const u = (e.dataTransfer.getData('text/uri-list') || '').split('\n').find(l => l && !l.startsWith('#'));
  if (u) { els.url.value = u.trim(); openUrl(u); }
});
// Paste a link anywhere (outside the text box) to play it.
document.addEventListener('paste', e => {
  if (e.target.closest && e.target.closest('input, textarea')) return;
  const text = (e.clipboardData.getData('text') || '').trim();
  if (/^https?:\/\/\S+$/.test(text)) { els.url.value = text; openUrl(text); }
});

/* ---------------- start ---------------- */
els.aspect.value = S.aspect;
if (els.aspect.value !== S.aspect) S.aspect = els.aspect.value = 'original';
els.aspectCustom.value = S.customAspect;
els.aspectCustom.hidden = S.aspect !== 'custom';
els.fps.value = S.fpsChoice;
if (els.fps.value !== S.fpsChoice) S.fpsChoice = els.fps.value = 'auto';
setAdvanced(S.advanced, true);
applyVolume();
updateSpeedUI();
showEmpty();
new ResizeObserver(layout).observe(els.stage);
requestAnimationFrame(tick);
if (!readLaunchParams()) readHash();
window.addEventListener('hashchange', readHash);

/* ---------------- PWA: install, share-to-app, open-with-app, offline ---------------- */
// Links shared to the installed app (Android share sheet) or opened as ?src=… arrive as query params.
// Shared text often wraps the link in other words, so pick out the first http(s) link.
function readLaunchParams() {
  const q = new URLSearchParams(location.search);
  if (![...q.keys()].length) return false;
  const text = ['src', 'url', 'text', 'title'].map(k => q.get(k) || '').join(' ');
  const m = text.match(/https?:\/\/[^\s"'<>]+/);
  history.replaceState(null, '', location.pathname + location.hash);
  if (!m) return false;
  els.url.value = m[0];
  openUrl(m[0]);
  return true;
}

// "Open with Frame" on desktop when the app is installed.
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async params => {
    if (params.files && params.files.length) openLocal(await params.files[0].getFile());
  });
}

let installEvent = null;
const installBtn = $('#installBtn');
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvent = e;
  installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null;
  installBtn.hidden = true;
});
window.addEventListener('appinstalled', () => { installBtn.hidden = true; osd('Installed'); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
