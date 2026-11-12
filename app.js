/* Lembar – scanner dokumen untuk HP. Semua diproses di perangkat. */
(() => {
  'use strict';

  // ---------- Pengaturan ----------
  const MAX_SIDE = 2400;     // sisi terpanjang halaman yang disimpan (px)
  const DETECT_SIDE = 360;   // sisi terpanjang frame kecil untuk deteksi (px)
  const STABLE_MS = 1000;    // sudut harus stabil selama ini sebelum memotret
  const TICK_MS = 110;       // jeda antar deteksi
  const LOST_MS = 450;       // sudut dianggap hilang setelah selama ini tak terlihat

  const $ = (id) => document.getElementById(id);
  const el = {
    home: $('home'), startScanBtn: $('startScanBtn'), importBtn: $('importBtn'),
    recentDoc: $('recentDoc'), recentPreviewImg: $('recentPreviewImg'), recentTitle: $('recentTitle'),
    recentMeta: $('recentMeta'), recentPages: $('recentPages'), homeEmpty: $('homeEmpty'),
    allDocsBtn: $('allDocsBtn'), navDocsBtn: $('navDocsBtn'), homeBtn: $('homeBtn'),
    cam: $('cam'), res: $('res'), video: $('video'), overlay: $('overlay'), flash: $('flash'),
    status: $('status'), denied: $('denied'), pick: $('pick'), hint: $('hint'), hintClose: $('hintClose'),
    autoBtn: $('autoBtn'), shot: $('shot'), doneBtn: $('doneBtn'), count: $('count'),
    backBtn: $('backBtn'), title: $('title'), grid: $('grid'), empty: $('empty'),
    filters: $('filters'), name: $('name'), pdfBtn: $('pdfBtn'), zipBtn: $('zipBtn'), newBtn: $('newBtn'),
    sheet: $('sheet'), sheetImg: $('sheetImg'), rotBtn: $('rotBtn'), delBtn: $('delBtn'), closeSheet: $('closeSheet'),
    ready: $('ready'), readyText: $('readyText'), readyBtn: $('readyBtn'), readyClose: $('readyClose'),
    busy: $('busy'), busyText: $('busyText'),
    cropBtn: $('cropBtn'), crop: $('crop'), cropCanvas: $('cropCanvas'), cropCancel: $('cropCancel'), cropSave: $('cropSave')
  };

  const state = { pages: [], filter: 'tajam', screen: 'home', auto: true, nameEdited: false };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const maxDist = (q1, q2) => Math.max(...q1.map((p, i) => dist(p, q2[i])));

  // ---------- Penyimpanan (semua dibungkus try/catch) ----------
  function lsGet(key) { try { return localStorage.getItem('lembar.' + key); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem('lembar.' + key, val); } catch (e) { /* abaikan */ } }

  const store = {
    db: null,
    open() {
      return new Promise((resolve) => {
        try {
          const req = indexedDB.open('lembar', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('pages', { keyPath: 'id' });
          req.onsuccess = () => { this.db = req.result; resolve(true); };
          req.onerror = () => resolve(false);
          req.onblocked = () => resolve(false);
        } catch (e) { resolve(false); }
      });
    },
    run(mode, fn) {
      return new Promise((resolve) => {
        if (!this.db) return resolve(null);
        try {
          const tx = this.db.transaction('pages', mode);
          const req = fn(tx.objectStore('pages'));
          tx.oncomplete = () => resolve(req && req.result !== undefined ? req.result : null);
          tx.onerror = tx.onabort = () => resolve(null);
        } catch (e) { resolve(null); }
      });
    },
    all() { return this.run('readonly', (s) => s.getAll()); },
    put(rec) { return this.run('readwrite', (s) => s.put(rec)); },
    del(id) { return this.run('readwrite', (s) => s.delete(id)); },
    clear() { return this.run('readwrite', (s) => s.clear()); }
  };

  // Urutan, rotasi, dan filter disimpan terpisah (kecil), gambar di IndexedDB.
  function saveMeta() {
    const rot = {};
    state.pages.forEach((p) => { if (p.rot) rot[p.id] = p.rot; });
    lsSet('meta', JSON.stringify({ order: state.pages.map((p) => p.id), rot, filter: state.filter }));
  }
  function loadMeta() {
    try { return JSON.parse(lsGet('meta')) || {}; } catch (e) { return {}; }
  }

  function updateHome() {
    const page = state.pages[0];
    const hasPages = state.pages.length > 0;
    el.recentDoc.hidden = !hasPages;
    el.homeEmpty.hidden = hasPages;
    if (!hasPages) return;

    el.recentTitle.textContent = el.name.value.trim() || 'Dokumen hasil scan';
    el.recentPages.textContent = `${state.pages.length} halaman`;
    const timestamp = Number(String(page.id).split('-')[0]);
    el.recentMeta.textContent = Number.isFinite(timestamp)
      ? new Date(timestamp).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })
      : 'Dokumen terbaru';
    el.recentPreviewImg.hidden = !page.thumb;
    el.recentPreviewImg.src = page.thumb || '';
    el.recentPreviewImg.nextElementSibling.hidden = !!page.thumb;
  }

  async function restorePages() {
    const meta = loadMeta();
    if (['asli', 'bw', 'tajam'].includes(meta.filter)) state.filter = meta.filter;
    await store.open();
    const recs = (await store.all()) || [];
    const order = meta.order || [];
    const rank = (id) => { const i = order.indexOf(id); return i < 0 ? 1e9 : i; };
    recs.sort((a, b) => rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : 1));
    const old = [];
    for (const r of recs) {
      try {
        old.push({
          id: r.id, blob: new Blob([r.buf], { type: r.type || 'image/jpeg' }),
          orig: r.orig ? new Blob([r.orig], { type: 'image/jpeg' }) : null,
          quad: r.quad || null,
          rot: (meta.rot && meta.rot[r.id]) || 0, thumb: null, key: ''
        });
      } catch (e) { /* lewati rekaman rusak */ }
    }
    state.pages = old.concat(state.pages);
    updateCount(false);
    updateHome();
  }

  let seq = 0;
  // blob = hasil potong; orig = foto utuh (untuk atur ulang potongan); quad = 4 sudut, skala 0..1 terhadap orig.
  async function addPage(blob, orig, quad) {
    const p = { id: Date.now() + '-' + (seq++), blob, orig: orig || null, quad: quad || null, rot: 0, thumb: null, key: '' };
    state.pages.push(p);
    updateCount(true);
    saveMeta();
    persist(p);
    updateHome();
  }
  // Simpan di latar belakang: jangan sampai penyimpanan yang macet menahan jepretan berikutnya.
  function persist(p) {
    Promise.all([p.blob.arrayBuffer(), p.orig ? p.orig.arrayBuffer() : null])
      .then(([buf, orig]) => store.put({ id: p.id, buf, type: p.blob.type, orig, quad: p.quad }))
      .catch(() => { /* tetap di memori */ });
  }

  function updateCount(bump) {
    el.count.textContent = state.pages.length;
    if (bump) {
      el.count.classList.remove('bump');
      void el.count.offsetWidth;
      el.count.classList.add('bump');
    }
  }

  // ---------- Util gambar ----------
  function toBlob(canvas, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  }
  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Gambar tidak terbaca')); };
      im.src = url;
    });
  }
  function freeCanvas(c) { c.width = c.height = 0; }

  // ---------- OpenCV: deteksi tepi & perspektif ----------
  let cvOk = false;
  let kernel = null, closeKernel = null;

  function waitCv() {
    const check = () => {
      if (window.__cvFail) { setStatus(); return; }
      const c = window.cv;
      if (!c) return setTimeout(check, 150);
      if (c.Mat) return cvLoaded();
      if (typeof c.then === 'function') {
        // Beberapa build mengembalikan Promise; jangan pernah me-resolve dengan modulnya sendiri.
        c.then((m) => { window.cv = m; cvLoaded(); });
        return;
      }
      c.onRuntimeInitialized = cvLoaded;
    };
    check();
  }
  function cvLoaded() {
    try {
      kernel = cv.Mat.ones(3, 3, cv.CV_8U);
      closeKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
      cvOk = true;
    } catch (e) { window.__cvFail = true; }
    setStatus();
  }

  // Urutkan 4 titik: kiri-atas, kanan-atas, kanan-bawah, kiri-bawah.
  function orderQuad(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    const s = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    let first = 0;
    s.forEach((p, i) => { if (p.x + p.y < s[first].x + s[first].y) first = i; });
    return [0, 1, 2, 3].map((i) => s[(first + i) % 4]);
  }

  // Ubah satu kontur jadi segi empat (lewat convex hull supaya tahan tepi bergerigi,
  // sudut tumpul, atau jari yang menutupi sedikit). Mengembalikan { pts, score } atau null.
  function quadFrom(c, area, w, h) {
    const hull = new cv.Mat(), ap = new cv.Mat();
    try {
      cv.convexHull(c, hull, false, true);
      const peri = cv.arcLength(hull, true);
      for (const eps of [0.02, 0.035, 0.05, 0.08]) {
        cv.approxPolyDP(hull, ap, eps * peri, true);
        if (ap.rows <= 4) break;
      }
      if (ap.rows !== 4) return null;
      const qa = cv.contourArea(ap, false);
      if (qa < w * h * 0.05 || qa > w * h * 0.97) return null;
      const fit = area / qa;                     // seberapa penuh kontur mengisi segi empatnya
      if (fit < 0.75) return null;
      const d = ap.data32S;
      const pts = orderQuad([0, 1, 2, 3].map((j) => ({ x: d[j * 2], y: d[j * 2 + 1] })));
      const minSide = Math.min(w, h) * 0.15;
      for (let i = 0; i < 4; i++) {
        const p = pts[i], a = pts[(i + 3) % 4], b = pts[(i + 1) % 4];
        const la = dist(p, a), lb = dist(p, b);
        if (la < minSide || lb < minSide) return null;
        const cos = ((a.x - p.x) * (b.x - p.x) + (a.y - p.y) * (b.y - p.y)) / (la * lb);
        if (Math.abs(cos) > 0.77) return null;   // sudut di luar 40°–140°: bukan kertas
      }
      // Sudut yang menempel di tepi frame biasanya milik latar (meja, lantai) yang terpotong
      // layar, bukan milik kertas. Tiga sudut atau lebih di tepi: tolak.
      const mx = w * 0.02, my = h * 0.02;
      const onEdge = pts.filter((p) => p.x < mx || p.y < my || p.x > w - 1 - mx || p.y > h - 1 - my).length;
      if (onEdge >= 3) return null;
      const penalty = onEdge === 2 ? 0.4 : onEdge === 1 ? 0.8 : 1;
      return { pts, score: qa * fit * fit * penalty };
    } finally { hull.delete(); ap.delete(); }
  }

  function bestQuad(bin, w, h) {
    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    let best = null;
    try {
      cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const minArea = w * h * 0.04;
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const area = cv.contourArea(c, false);
        if (area > minArea) {
          const q = quadFrom(c, area, w, h);
          if (q && (!best || q.score > best.score)) best = q;
        }
        c.delete();
      }
    } finally { contours.delete(); hier.delete(); }
    return best;
  }

  // Cari kertas di frame kecil. Mengembalikan { quad | null, sig } (sig = salinan abu-abu untuk membandingkan frame).
  function detect(img) {
    const w = img.width, h = img.height;
    const src = cv.matFromImageData(img);
    const gray = new cv.Mat();
    const clean = new cv.Mat();
    const bin = new cv.Mat();
    const edges = cv.Mat.zeros(h, w, cv.CV_8U);
    const rgb = new cv.Mat(), hsv = new cv.Mat(), lab = new cv.Mat();
    const chans = new cv.MatVector(), hs = new cv.MatVector(), ls = new cv.MatVector();
    const anchor = new cv.Point(-1, -1);
    const ksize = new cv.Size(5, 5);
    const border = cv.morphologyDefaultBorderValue();
    let quad = null, sig = null;
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
      cv.GaussianBlur(gray, gray, ksize, 0, 0, cv.BORDER_DEFAULT);
      sig = new Uint8Array(gray.data);

      // Cara 1: tepi (Canny) di tiap kanal warna, digabung. Kertas kuning di meja putih
      // nyaris tak terlihat di abu-abu, tapi jelas di kanal biru.
      cv.split(src, chans);
      for (let i = 0; i < 3; i++) {
        const m = chans.get(i);
        cv.GaussianBlur(m, m, ksize, 0, 0, cv.BORDER_DEFAULT);
        // Hapus tulisan (morphological close) supaya yang tersisa hanya tepi kertas.
        cv.morphologyEx(m, clean, cv.MORPH_CLOSE, closeKernel, anchor, 1, cv.BORDER_REPLICATE, border);
        cv.Canny(clean, bin, 30, 90, 3, false);
        cv.bitwise_or(edges, bin, edges);
        m.delete();
      }
      cv.dilate(edges, edges, kernel, anchor, 2, cv.BORDER_CONSTANT, border);
      const a = bestQuad(edges, w, h);
      if (a) {
        // Kontur tepi yang ditebalkan sedikit di luar kertas: geser masuk sekitar 2 px.
        const cx = (a.pts[0].x + a.pts[1].x + a.pts[2].x + a.pts[3].x) / 4;
        const cy = (a.pts[0].y + a.pts[1].y + a.pts[2].y + a.pts[3].y) / 4;
        a.pts = a.pts.map((p) => {
          const l = Math.hypot(p.x - cx, p.y - cy) || 1;
          return { x: p.x - (p.x - cx) / l * 2.5, y: p.y - (p.y - cy) / l * 2.5 };
        });
      }

      // Cara 2: kertas sebagai bidang. (a) lebih terang dari latar, (b) lebih berwarna
      // dari latar (kertas warna di meja netral), (c) kurang berwarna (kertas putih di meja warna).
      let b = null;
      const dbg = window.__lembarDbg;
      if (dbg) dbg.push({ name: 'tepi', q: a });
      const consider = (name) => {
        const q = bestQuad(bin, w, h);
        if (dbg) dbg.push({ name, q });
        if (q && (!b || q.score > b.score)) b = q;
      };
      // Pisahkan satu kanal jadi dua kelompok (Otsu), dua arah: kertas lebih tinggi atau lebih rendah dari latar.
      const both = (m, name) => {
        cv.GaussianBlur(m, m, ksize, 0, 0, cv.BORDER_DEFAULT);
        cv.threshold(m, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        consider(name + '+');
        cv.threshold(m, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
        consider(name + '-');
      };
      cv.morphologyEx(gray, clean, cv.MORPH_CLOSE, closeKernel, anchor, 1, cv.BORDER_REPLICATE, border);
      cv.threshold(clean, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      consider('terang');
      cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB, 0);
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV, 0);
      cv.split(hsv, hs);
      const sat = hs.get(1);
      both(sat, 'jenuh');
      sat.delete();
      // Rona warna (Lab): kanal a = hijau↔merah, kanal b = biru↔kuning. Memisahkan mis. kartu
      // kebiruan dari meja krem walau sama terangnya.
      cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab, 0);
      cv.split(lab, ls);
      for (const i of [1, 2]) {
        const m = ls.get(i);
        both(m, i === 1 ? 'a' : 'b');
        m.delete();
      }

      const best = a && b ? (b.score >= a.score * 0.9 ? b : a) : (a || b);
      quad = best ? best.pts : null;
    } finally {
      src.delete(); gray.delete(); clean.delete(); bin.delete(); edges.delete();
      rgb.delete(); hsv.delete(); lab.delete(); chans.delete(); hs.delete(); ls.delete();
    }
    return { quad, sig };
  }

  // Bagian piksel yang berubah jauh di antara dua frame kecil (0..1).
  function changed(a, b) {
    if (!a || !b || a.length !== b.length) return 1;
    let n = 0, total = 0;
    for (let i = 0; i < a.length; i += 3) {
      total++;
      const d = a[i] - b[i];
      if (d > 30 || d < -30) n++;
    }
    return n / total;
  }

  // Potong & luruskan dari canvas resolusi penuh. quad dalam koordinat canvas.
  function warp(canvas, quad) {
    const [tl, tr, br, bl] = quad;
    let W = Math.max(dist(tl, tr), dist(bl, br));
    let H = Math.max(dist(tl, bl), dist(tr, br));
    const s = Math.min(1, MAX_SIDE / Math.max(W, H));
    W = Math.round(W * s); H = Math.round(H * s);
    if (W < 60 || H < 60) throw new Error('quad terlalu kecil');
    const ctx = canvas.getContext('2d');
    const src = cv.matFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
    const a = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
    const b = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
    const dst = new cv.Mat();
    let M = null;
    try {
      M = cv.getPerspectiveTransform(a, b);
      cv.warpPerspective(src, dst, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
      const out = document.createElement('canvas');
      out.width = W; out.height = H;
      out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(dst.data), W, H), 0, 0);
      return out;
    } finally { src.delete(); a.delete(); b.delete(); dst.delete(); if (M) M.delete(); }
  }

  // ---------- Kamera ----------
  const small = document.createElement('canvas');
  const sctx = small.getContext('2d', { willReadFrequently: true });
  const full = document.createElement('canvas');
  const fctx = full.getContext('2d', { willReadFrequently: true });
  const octx = el.overlay.getContext('2d');

  let stream = null, starting = false, camDenied = false, busy = false;

  // Status pelacakan kertas
  const T = { quad: null, shown: null, anchor: null, since: 0, lastSeen: 0, locked: false, lockSig: null, lockQuad: null, chg: 0, prog: 0 };

  async function startCam() {
    if (stream || starting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { showDenied(); return; }
    starting = true;
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } }
      });
      if (state.screen !== 'cam' || document.hidden) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      camDenied = false;
      el.denied.hidden = true;
      el.video.srcObject = s;
      try { await el.video.play(); } catch (e) { /* autoplay akan menyusul */ }
    } catch (e) {
      showDenied();
    } finally {
      starting = false;
      setStatus();
    }
  }
  function stopCam() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      el.video.srcObject = null;
    }
    T.quad = T.shown = T.anchor = null;
    octx.clearRect(0, 0, el.overlay.width, el.overlay.height);
  }
  function showDenied() {
    camDenied = true;
    el.denied.hidden = false;
    el.hint.hidden = true;
    setStatus();
  }

  function setStatus(text) {
    if (!text) {
      if (camDenied) text = 'Kamera tidak tersedia';
      else if (!stream) text = 'Menyiapkan kamera…';
      else if (window.__cvFail) text = 'Deteksi tepi tidak tersedia · potret manual';
      else if (!cvOk) text = 'Memuat detektor tepi…';
      else if (T.locked) text = 'Tersimpan ✓ · ganti kertas';
      else if (!state.auto) text = T.quad ? 'Kertas terdeteksi · potret manual' : 'Mode manual';
      else if (T.quad) text = 'Tahan sebentar…';
      else text = 'Arahkan kamera ke kertas';
    }
    if (el.status.textContent !== text) el.status.textContent = text;
  }

  function smallSize(w, h) {
    const k = DETECT_SIDE / Math.max(w, h);
    return { k, w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }

  function tick() {
    setTimeout(tick, TICK_MS);
    if (state.screen !== 'cam' || !stream || busy || document.hidden) return;
    const vw = el.video.videoWidth, vh = el.video.videoHeight;
    if (!vw || el.video.readyState < 2) return;
    if (!cvOk) { setStatus(); return; }
    const s = smallSize(vw, vh);
    if (small.width !== s.w || small.height !== s.h) { small.width = s.w; small.height = s.h; }
    let d;
    try {
      sctx.drawImage(el.video, 0, 0, s.w, s.h);
      d = detect(sctx.getImageData(0, 0, s.w, s.h));
    } catch (e) { return; }
    track(d, s.w, s.h);
  }

  function track(d, sw, sh) {
    const now = performance.now();
    const tol = Math.max(sw, sh) * 0.04;
    const q = d.quad;

    if (q) {
      T.lastSeen = now;
      T.quad = q;
      T.shown = T.shown
        ? T.shown.map((p, i) => ({ x: p.x + (q[i].x - p.x) * 0.6, y: p.y + (q[i].y - p.y) * 0.6 }))
        : q;
      if (!T.anchor || maxDist(q, T.anchor) > tol) { T.anchor = q; T.since = now; }
    } else if (now - T.lastSeen > LOST_MS) {
      T.quad = T.shown = T.anchor = null;
    }

    // Terkunci sampai kertas berganti: sudut hilang, atau isi frame berubah jauh.
    if (T.locked) {
      T.chg = changed(d.sig, T.lockSig) > 0.25 ? T.chg + 1 : 0;
      if (!T.quad || T.chg >= 3) {
        T.locked = false;
        T.chg = 0;
        T.anchor = null;
      }
    }

    T.prog = 0;
    if (state.auto && !T.locked && T.quad && T.anchor) {
      T.prog = Math.min(1, (now - T.since) / STABLE_MS);
      if (T.prog >= 1) {
        const same = T.lockSig && T.lockQuad &&
          changed(d.sig, T.lockSig) < 0.015 && maxDist(T.quad, T.lockQuad) < tol;
        if (same) T.locked = true;      // pemandangan persis sama: kertas yang tadi, jangan dipotret lagi
        else capture();
      }
    }

    drawOverlay(sw);
    setStatus();
  }

  function drawOverlay(sw) {
    const ov = el.overlay;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.round(ov.clientWidth * dpr), ch = Math.round(ov.clientHeight * dpr);
    if (ov.width !== cw || ov.height !== ch) { ov.width = cw; ov.height = ch; }
    octx.clearRect(0, 0, cw, ch);
    const q = T.shown;
    const vw = el.video.videoWidth, vh = el.video.videoHeight;
    if (!q || !vw) return;
    // Petakan frame kecil -> video -> layar (object-fit: cover)
    const s = Math.max(cw / vw, ch / vh);
    const ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
    const k = (vw / sw) * s;
    octx.beginPath();
    q.forEach((p, i) => {
      const x = ox + p.x * k, y = oy + p.y * k;
      if (i) octx.lineTo(x, y); else octx.moveTo(x, y);
    });
    octx.closePath();
    const color = T.locked ? '147,160,177' : (T.prog > 0 ? '45,212,167' : '255,255,255');
    octx.fillStyle = `rgba(${color},${T.locked ? 0.12 : 0.1 + 0.25 * T.prog})`;
    octx.fill();
    octx.lineJoin = 'round';
    octx.lineWidth = (T.locked ? 2 : 3 + 3 * T.prog) * dpr;
    octx.setLineDash(T.locked ? [10 * dpr, 8 * dpr] : []);
    octx.strokeStyle = `rgb(${color})`;
    octx.stroke();
  }

  // Bunyi, kedip, getar
  let actx = null;
  function initAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!actx && AC) actx = new AC();
      if (actx && actx.state === 'suspended') actx.resume();
    } catch (e) { /* tanpa bunyi */ }
  }
  function feedback() {
    el.flash.classList.remove('on');
    void el.flash.offsetWidth;
    el.flash.classList.add('on');
    try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) { /* abaikan */ }
    try {
      if (!actx || actx.state !== 'running') return;
      const t = actx.currentTime;
      const osc = actx.createOscillator(), gain = actx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1320, t);
      gain.gain.setValueAtTime(0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      osc.connect(gain).connect(actx.destination);
      osc.start(t);
      osc.stop(t + 0.1);
    } catch (e) { /* abaikan */ }
  }

  // Cari kertas di canvas resolusi penuh; kembalikan quad dalam koordinat canvas itu.
  function findQuad(canvas) {
    const s = smallSize(canvas.width, canvas.height);
    small.width = s.w; small.height = s.h;
    sctx.drawImage(canvas, 0, 0, s.w, s.h);
    const d = detect(sctx.getImageData(0, 0, s.w, s.h));
    return { smallQuad: d.quad, sig: d.sig, k: s.k };
  }

  async function capture() {
    if (busy || !stream) return;
    const vw = el.video.videoWidth, vh = el.video.videoHeight;
    if (!vw) return;
    busy = true;
    try {
      full.width = vw; full.height = vh;
      fctx.drawImage(el.video, 0, 0, vw, vh);

      let smallQuad = null, sig = null, quad = null;
      if (cvOk) {
        try {
          const f = findQuad(full);     // deteksi ulang tepat di frame yang dipotret
          sig = f.sig;
          smallQuad = f.smallQuad || (T.quad && performance.now() - T.lastSeen < 600 ? T.quad : null);
          if (smallQuad) quad = smallQuad.map((p) => ({ x: p.x / f.k, y: p.y / f.k }));
        } catch (e) { quad = null; }
      }

      feedback();

      let out = full;
      if (quad) { try { out = warp(full, quad); } catch (e) { out = full; } }  // gagal -> simpan foto utuh
      const blob = await toBlob(out, 0.9);
      const cropped = out !== full;
      if (cropped) freeCanvas(out);
      const orig = await toBlob(full, 0.85);
      if (blob) await addPage(blob, orig, cropped ? quad.map((p) => ({ x: p.x / vw, y: p.y / vh })) : null);

      T.locked = true;
      T.lockSig = sig;
      T.lockQuad = smallQuad;
      T.anchor = null;
      T.chg = 0;
      setStatus();
    } finally {
      busy = false;
    }
  }

  // Foto dari galeri (dipakai kalau kamera ditolak)
  async function importFiles(files) {
    if (!files.length) return;
    showBusy('Memproses foto…');
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      el.busyText.textContent = `Memproses foto ${i + 1}/${files.length}…`;
      try {
        const im = await loadImage(files[i]);
        const s = Math.min(1, 3000 / Math.max(im.naturalWidth, im.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(im.naturalWidth * s);
        c.height = Math.round(im.naturalHeight * s);
        c.getContext('2d', { willReadFrequently: true }).drawImage(im, 0, 0, c.width, c.height);
        let out = c, quad = null;
        if (cvOk) {
          try {
            const f = findQuad(c);
            if (f.smallQuad) {
              quad = f.smallQuad.map((p) => ({ x: p.x / f.k, y: p.y / f.k }));
              out = warp(c, quad);
            }
          } catch (e) { out = c; }
        }
        const blob = await toBlob(out, 0.9);
        const cropped = out !== c;
        if (cropped) freeCanvas(out);
        const orig = await toBlob(c, 0.85);
        const norm = cropped ? quad.map((p) => ({ x: p.x / c.width, y: p.y / c.height })) : null;
        freeCanvas(c);
        if (blob) { await addPage(blob, orig, norm); ok++; }
      } catch (e) { /* lewati file yang gagal */ }
      await sleep(0);
    }
    hideBusy();
    if (ok) show('res');
  }

  // ---------- Filter (JavaScript murni, jalan walau OpenCV belum termuat) ----------
  function toGray(d) {
    const n = d.width * d.height, px = d.data, g = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
    return g;
  }
  // Rata-rata lokal (kotak radius r) lewat integral image.
  function meanMap(g, w, h, r) {
    const W = w + 1, I = new Uint32Array(W * (h + 1)), m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      let row = 0;
      const o = (y + 1) * W, po = y * W, go = y * w;
      for (let x = 0; x < w; x++) { row += g[go + x]; I[o + x + 1] = I[po + x + 1] + row; }
    }
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        m[y * w + x] = (I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
      }
    }
    return m;
  }
  // Hitam-putih: ambang adaptif, tahan terhadap bayangan.
  function filterBW(d) {
    const w = d.width, h = d.height, px = d.data;
    const g = toGray(d), m = meanMap(g, w, h, Math.max(8, w >> 4));
    for (let i = 0, j = 0; i < g.length; i++, j += 4) {
      const v = g[i] < m[i] * 0.88 ? 0 : 255;
      px[j] = px[j + 1] = px[j + 2] = v;
    }
  }
  // Perkiraan warna kertas kosong di tiap titik (per kanal): gambar diperkecil, tulisan dan
  // gambar kecil dihapus dengan filter maksimum berjendela besar, dihaluskan, lalu diperbesar lagi.
  function paperMap(canvas) {
    const w = canvas.width, h = canvas.height;
    const k = Math.min(1, 200 / Math.max(w, h));
    const sw = Math.max(8, Math.round(w * k)), sh = Math.max(8, Math.round(h * k));
    const s = document.createElement('canvas');
    s.width = sw; s.height = sh;
    const sx = s.getContext('2d', { willReadFrequently: true });
    sx.drawImage(canvas, 0, 0, sw, sh);
    const d = sx.getImageData(0, 0, sw, sh), px = d.data;
    const n = sw * sh, a = new Float32Array(n), t = new Float32Array(n);
    const rMax = Math.max(2, Math.round(Math.max(sw, sh) * 0.14));
    const rBlur = Math.max(2, Math.round(Math.max(sw, sh) * 0.05));
    const pass = (src, dst, r, isMax, horizontal) => {
      const len = horizontal ? sw : sh, lines = horizontal ? sh : sw, step = horizontal ? 1 : sw;
      for (let l = 0; l < lines; l++) {
        const base = horizontal ? l * sw : l;
        for (let i = 0; i < len; i++) {
          const i0 = Math.max(0, i - r), i1 = Math.min(len - 1, i + r);
          let v = 0;
          if (isMax) { for (let j = i0; j <= i1; j++) { const q = src[base + j * step]; if (q > v) v = q; } }
          else { for (let j = i0; j <= i1; j++) v += src[base + j * step]; v /= (i1 - i0 + 1); }
          dst[base + i * step] = v;
        }
      }
    };
    for (let c = 0; c < 3; c++) {
      const hist = new Uint32Array(256);
      for (let i = 0; i < n; i++) { a[i] = px[i * 4 + c]; hist[px[i * 4 + c]]++; }
      // Batas atas = terang kertas pada umumnya (persentil 85). Mencegah sisa latar yang lebih
      // terang di pinggir (mis. meja putih di sudut) dianggap sebagai warna kertas.
      let cap = 255, acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.85) { cap = Math.min(255, v * 1.04); break; } }
      pass(a, t, rMax, true, true); pass(t, a, rMax, true, false);
      for (let i = 0; i < n; i++) if (a[i] > cap) a[i] = cap;
      pass(a, t, rBlur, false, true); pass(t, a, rBlur, false, false);
      for (let i = 0; i < n; i++) px[i * 4 + c] = a[i];
    }
    sx.putImageData(d, 0, 0);
    const f = document.createElement('canvas');
    f.width = w; f.height = h;
    const fx = f.getContext('2d', { willReadFrequently: true });
    fx.imageSmoothingEnabled = true;
    fx.imageSmoothingQuality = 'high';
    fx.drawImage(s, 0, 0, w, h);
    const out = fx.getImageData(0, 0, w, h).data;
    freeCanvas(s); freeCanvas(f);
    return out;
  }

  // Tajam: kertas jadi putih bersih (bayangan & warna kertas hilang), warna dipertegas,
  // tulisan dipergelap dan dipertajam.
  function filterSharp(d, canvas) {
    const w = d.width, h = d.height, px = d.data;
    const bg = paperMap(canvas);
    const LO = 28, SPAN = 255 / (236 - LO), SAT = 1.45;
    for (let j = 0; j < px.length; j += 4) {
      // 1) bagi dengan warna kertas -> kertas = putih; 2) regangkan kontras
      let r = (px[j] * 250 / Math.max(bg[j], 70) - LO) * SPAN;
      let g = (px[j + 1] * 250 / Math.max(bg[j + 1], 70) - LO) * SPAN;
      let b = (px[j + 2] * 250 / Math.max(bg[j + 2], 70) - LO) * SPAN;
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;
      // 3) pertegas warna (logo, stempel, tanda tangan)
      const l = r * 0.3 + g * 0.59 + b * 0.11;
      px[j] = l + (r - l) * SAT;
      px[j + 1] = l + (g - l) * SAT;
      px[j + 2] = l + (b - l) * SAT;
    }
    const src = new Uint8ClampedArray(px);
    const row = w * 4;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const j = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const k = j + c;
          px[k] = src[k] + 0.5 * (4 * src[k] - src[k - 4] - src[k + 4] - src[k - row] - src[k + row]);
        }
      }
    }
  }

  // Gambar satu halaman (rotasi + filter) ke canvas baru.
  async function renderPage(p, maxSide) {
    const im = await loadImage(p.blob);
    const s = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight));
    const w = Math.max(1, Math.round(im.naturalWidth * s)), h = Math.max(1, Math.round(im.naturalHeight * s));
    const side = p.rot % 180 !== 0;
    const c = document.createElement('canvas');
    c.width = side ? h : w;
    c.height = side ? w : h;
    const ctx = c.getContext('2d', { willReadFrequently: state.filter !== 'asli' });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(p.rot * Math.PI / 180);
    ctx.drawImage(im, -w / 2, -h / 2, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (state.filter !== 'asli') {
      const d = ctx.getImageData(0, 0, c.width, c.height);
      if (state.filter === 'bw') filterBW(d); else filterSharp(d, c);
      ctx.putImageData(d, 0, 0);
    }
    return c;
  }

  // ---------- Layar hasil ----------
  function show(screen) {
    state.screen = screen;
    el.home.hidden = screen !== 'home';
    el.cam.hidden = screen !== 'cam';
    el.res.hidden = screen !== 'res';
    if (screen === 'cam') {
      startCam();
    } else {
      stopCam();
      if (screen === 'res') {
        if (!state.nameEdited || !el.name.value.trim()) { el.name.value = defaultName(); state.nameEdited = false; }
        renderGrid();
      } else {
        updateHome();
        if (state.pages.length) refreshThumbs();
      }
    }
  }

  function defaultName() {
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    return `Scan_${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`;
  }
  function fileBase() {
    const n = el.name.value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\.(pdf|zip)$/i, '').trim();
    return n || defaultName();
  }

  function renderGrid() {
    const n = state.pages.length;
    el.title.textContent = n ? `Hasil · ${n} halaman` : 'Hasil';
    el.empty.hidden = n > 0;
    el.grid.hidden = n === 0;
    el.pdfBtn.disabled = el.zipBtn.disabled = n === 0;
    [...el.filters.children].forEach((b) => b.setAttribute('aria-checked', String(b.dataset.f === state.filter)));
    el.grid.textContent = '';
    for (const p of state.pages) {
      const div = document.createElement('div');
      div.className = 'page';
      div.dataset.id = p.id;
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      if (p.thumb) img.src = p.thumb;
      div.appendChild(img);
      el.grid.appendChild(div);
    }
    refreshThumbs();
  }

  let thumbGen = 0;
  async function refreshThumbs() {
    const gen = ++thumbGen;
    for (const p of state.pages.slice()) {
      const key = state.filter + ':' + p.rot;
      if (p.thumb && p.key === key) continue;
      try {
        const c = await renderPage(p, 420);
        const b = await toBlob(c, 0.8);
        freeCanvas(c);
        if (gen !== thumbGen) return;
        if (p.thumb) URL.revokeObjectURL(p.thumb);
        p.thumb = URL.createObjectURL(b);
        p.key = key;
        const node = [...el.grid.children].find((n) => n.dataset.id === p.id);
        if (node) node.firstChild.src = p.thumb;
        if (p === state.pages[0]) updateHome();
        if (sheetPage === p) el.sheetImg.src = p.thumb;
      } catch (e) { /* lewati */ }
    }
  }

  // Lembar aksi: putar / hapus
  let sheetPage = null;
  function openSheet(p) {
    sheetPage = p;
    el.sheetImg.src = p.thumb || '';
    el.sheet.hidden = false;
  }
  function closeSheet() { sheetPage = null; el.sheet.hidden = true; }

  function rotatePage() {
    if (!sheetPage) return;
    sheetPage.rot = (sheetPage.rot + 90) % 360;
    saveMeta();
    refreshThumbs();
  }
  function deletePage() {
    const p = sheetPage;
    if (!p) return;
    state.pages = state.pages.filter((x) => x !== p);
    if (p.thumb) URL.revokeObjectURL(p.thumb);
    store.del(p.id);
    saveMeta();
    updateCount(false);
    closeSheet();
    renderGrid();
    updateHome();
  }

  // ---------- Atur sudut potong manual ----------
  const C = { page: null, img: null, pts: null, drag: -1, box: null };
  const kctx = el.cropCanvas.getContext('2d');

  async function openCrop() {
    const p = sheetPage;
    if (!p) return;
    closeSheet();
    try { C.img = await loadImage(p.orig || p.blob); } catch (e) { return; }
    C.page = p;
    C.pts = (p.orig && p.quad)
      ? p.quad.map((q) => ({ x: q.x, y: q.y }))
      : [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    C.drag = -1;
    el.crop.hidden = false;
    drawCrop();
  }
  function closeCrop() { C.page = null; C.img = null; el.crop.hidden = true; }

  function drawCrop() {
    if (!C.img) return;
    const cn = el.cropCanvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = cn.clientWidth, ch = cn.clientHeight;
    if (cn.width !== Math.round(cw * dpr) || cn.height !== Math.round(ch * dpr)) {
      cn.width = Math.round(cw * dpr); cn.height = Math.round(ch * dpr);
    }
    kctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    kctx.clearRect(0, 0, cw, ch);
    const pad = 28, iw = C.img.naturalWidth, ih = C.img.naturalHeight;
    const s = Math.min((cw - 2 * pad) / iw, (ch - 2 * pad) / ih);
    const w = iw * s, h = ih * s, x = (cw - w) / 2, y = (ch - h) / 2;
    C.box = { x, y, w, h };
    kctx.drawImage(C.img, x, y, w, h);
    const P = C.pts.map((p) => ({ x: x + p.x * w, y: y + p.y * h }));
    const poly = () => { P.forEach((p, i) => (i ? kctx.lineTo(p.x, p.y) : kctx.moveTo(p.x, p.y))); kctx.closePath(); };
    kctx.beginPath(); kctx.rect(x, y, w, h); poly();
    kctx.fillStyle = 'rgba(0,0,0,.55)';
    kctx.fill('evenodd');                       // gelapkan bagian yang akan dibuang
    kctx.beginPath(); poly();
    kctx.lineWidth = 2; kctx.strokeStyle = '#2dd4a7'; kctx.stroke();
    P.forEach((p, i) => {
      kctx.beginPath(); kctx.arc(p.x, p.y, i === C.drag ? 18 : 13, 0, Math.PI * 2);
      kctx.fillStyle = 'rgba(45,212,167,.35)'; kctx.fill();
      kctx.lineWidth = 3; kctx.strokeStyle = '#fff'; kctx.stroke();
    });
  }

  function bindCrop() {
    const cn = el.cropCanvas;
    const pos = (e) => { const r = cn.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    cn.addEventListener('pointerdown', (e) => {
      if (!C.box) return;
      const m = pos(e);
      let best = -1, bd = 48;
      C.pts.forEach((p, i) => {
        const d = Math.hypot(C.box.x + p.x * C.box.w - m.x, C.box.y + p.y * C.box.h - m.y);
        if (d < bd) { bd = d; best = i; }
      });
      C.drag = best;
      if (best >= 0) { try { cn.setPointerCapture(e.pointerId); } catch (err) { /* abaikan */ } drawCrop(); }
    });
    cn.addEventListener('pointermove', (e) => {
      if (C.drag < 0) return;
      const m = pos(e);
      C.pts[C.drag] = {
        x: Math.min(1, Math.max(0, (m.x - C.box.x) / C.box.w)),
        y: Math.min(1, Math.max(0, (m.y - C.box.y) / C.box.h))
      };
      drawCrop();
    });
    const up = () => { if (C.drag >= 0) { C.drag = -1; drawCrop(); } };
    cn.addEventListener('pointerup', up);
    cn.addEventListener('pointercancel', up);
    window.addEventListener('resize', () => { if (!el.crop.hidden) drawCrop(); });
  }

  async function saveCrop() {
    const p = C.page, im = C.img;
    if (!p || !im) return;
    showBusy('Memotong…');
    await sleep(30);
    try {
      const s = Math.min(1, 3000 / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(im.naturalWidth * s);
      c.height = Math.round(im.naturalHeight * s);
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.drawImage(im, 0, 0, c.width, c.height);
      const norm = orderQuad(C.pts);
      const q = norm.map((t) => ({ x: t.x * c.width, y: t.y * c.height }));
      let out;
      if (cvOk) {
        out = warp(c, q);
      } else {
        // Tanpa OpenCV: potong kotak lurus yang melingkupi 4 titik.
        const x0 = Math.min(...q.map((t) => t.x)), x1 = Math.max(...q.map((t) => t.x));
        const y0 = Math.min(...q.map((t) => t.y)), y1 = Math.max(...q.map((t) => t.y));
        if (x1 - x0 < 60 || y1 - y0 < 60) throw new Error('terlalu kecil');
        out = document.createElement('canvas');
        out.width = Math.round(x1 - x0); out.height = Math.round(y1 - y0);
        out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
      }
      const blob = await toBlob(out, 0.9);
      freeCanvas(out); freeCanvas(c);
      if (!blob) throw new Error('gagal menyimpan');
      if (!p.orig) p.orig = p.blob;             // halaman lama: hasil potong lama jadi sumbernya
      p.blob = blob;
      p.quad = norm;
      p.key = '';
      persist(p);
    } catch (e) {
      alert('Gagal memotong. Pastikan 4 titik membentuk kotak yang cukup besar.');
      hideBusy();
      return;
    }
    hideBusy();
    closeCrop();
    refreshThumbs();
  }

  // Ketuk = buka aksi; tahan lalu seret = ubah urutan.
  function bindGrid() {
    let item = null, sx = 0, sy = 0, gx = 0, gy = 0, timer = 0, drag = false, moved = false, ghost = null;

    const start = (x, y, target) => {
      item = target.closest ? target.closest('.page') : null;
      if (!item) return;
      sx = x; sy = y; moved = false; drag = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!item || moved) return;
        drag = true;
        const r = item.getBoundingClientRect();
        gx = sx - r.left; gy = sy - r.top;
        ghost = item.cloneNode(true);
        ghost.classList.add('ghost');
        ghost.style.width = r.width + 'px';
        ghost.style.height = r.height + 'px';
        ghost.style.left = r.left + 'px';
        ghost.style.top = r.top + 'px';
        document.body.appendChild(ghost);
        item.classList.add('placeholder');
        try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) { /* abaikan */ }
      }, 380);
    };

    const move = (x, y, ev) => {
      if (!item) return;
      if (!drag) {
        if (Math.hypot(x - sx, y - sy) > 10) { moved = true; clearTimeout(timer); }
        return;
      }
      if (ev.cancelable) ev.preventDefault();   // cegah layar ikut bergulir saat menyeret
      ghost.style.left = (x - gx) + 'px';
      ghost.style.top = (y - gy) + 'px';
      const under = document.elementFromPoint(x, y);
      const over = under && under.closest ? under.closest('.page') : null;
      if (over && over !== item && over.parentNode === el.grid) {
        const kids = [...el.grid.children];
        if (kids.indexOf(over) > kids.indexOf(item)) over.after(item); else over.before(item);
      }
      const gr = el.grid.getBoundingClientRect();
      if (y < gr.top + 50) el.grid.scrollTop -= 14;
      else if (y > gr.bottom - 50) el.grid.scrollTop += 14;
    };

    const end = (cancel) => {
      clearTimeout(timer);
      if (!item) return;
      const cur = item;
      item = null;
      if (drag) {
        drag = false;
        if (ghost) { ghost.remove(); ghost = null; }
        cur.classList.remove('placeholder');
        const ids = [...el.grid.children].map((n) => n.dataset.id);
        state.pages.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        saveMeta();
      } else if (!moved && !cancel) {
        const p = state.pages.find((x) => x.id === cur.dataset.id);
        if (p) openSheet(p);
      }
    };

    el.grid.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY, e.target);
    }, { passive: true });
    el.grid.addEventListener('touchmove', (e) => move(e.touches[0].clientX, e.touches[0].clientY, e), { passive: false });
    el.grid.addEventListener('touchend', (e) => {
      if (item && e.cancelable) e.preventDefault();   // jangan sampai jadi klik ganda (mouse tiruan)
      end(false);
    });
    el.grid.addEventListener('touchcancel', () => end(true));
    el.grid.addEventListener('mousedown', (e) => { if (e.button === 0) start(e.clientX, e.clientY, e.target); });
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY, e));
    window.addEventListener('mouseup', () => end(false));
    el.grid.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---------- Bagikan ----------
  function showBusy(text) { el.busyText.textContent = text; el.busy.hidden = false; }
  function hideBusy() { el.busy.hidden = true; }

  async function buildPdf() {
    const { jsPDF } = window.jspdf;
    let doc = null;
    for (let i = 0; i < state.pages.length; i++) {
      el.busyText.textContent = `Membuat PDF… ${i + 1}/${state.pages.length}`;
      await sleep(0);
      const c = await renderPage(state.pages[i], 2000);
      const land = c.width > c.height;
      if (!doc) doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: land ? 'landscape' : 'portrait', compress: true });
      else doc.addPage('a4', land ? 'landscape' : 'portrait');
      const pw = land ? 297 : 210, ph = land ? 210 : 297;
      const r = Math.min(pw / c.width, ph / c.height);
      const w = c.width * r, h = c.height * r;
      doc.addImage(c.toDataURL('image/jpeg', 0.82), 'JPEG', (pw - w) / 2, (ph - h) / 2, w, h, undefined, 'FAST');
      freeCanvas(c);
    }
    return doc.output('blob');
  }

  async function buildZip() {
    const zip = new JSZip();
    for (let i = 0; i < state.pages.length; i++) {
      el.busyText.textContent = `Membuat ZIP… ${i + 1}/${state.pages.length}`;
      await sleep(0);
      const c = await renderPage(state.pages[i], MAX_SIDE);
      const b = await toBlob(c, 0.9);
      freeCanvas(c);
      zip.file(String(i + 1).padStart(3, '0') + '.jpg', b);
    }
    return zip.generateAsync({ type: 'blob', compression: 'STORE' });
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function canShareFile(file) {
    try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] })); }
    catch (e) { return false; }
  }

  let pending = null;   // file yang menunggu ketukan "Bagikan sekarang"
  async function deliver(blob, filename, type) {
    let file = null;
    try { file = new File([blob], filename, { type }); } catch (e) { file = null; }
    if (!file || !canShareFile(file)) { download(blob, filename); return; }
    try {
      await navigator.share({ files: [file], title: filename });
    } catch (e) {
      if (e && e.name === 'AbortError') return;          // pengguna menutup menu bagikan
      if (e && e.name === 'NotAllowedError') {           // butuh ketukan baru (umum di iPhone kalau file lama dibuat)
        pending = { blob, file, filename };
        el.readyText.textContent = filename + ' siap.';
        el.ready.hidden = false;
        return;
      }
      download(blob, filename);
    }
  }
  async function sharePending() {
    const p = pending;
    pending = null;
    el.ready.hidden = true;
    if (!p) return;
    try { await navigator.share({ files: [p.file], title: p.filename }); }
    catch (e) { if (!e || e.name !== 'AbortError') download(p.blob, p.filename); }
  }

  let exporting = false;
  async function exportAs(kind) {
    if (exporting || !state.pages.length) return;
    if (kind === 'pdf' ? !window.jspdf : !window.JSZip) {
      alert('Komponen pembuat file belum termuat. Sambungkan internet sekali, lalu buka ulang app.');
      return;
    }
    exporting = true;
    showBusy(kind === 'pdf' ? 'Membuat PDF…' : 'Membuat ZIP…');
    let blob = null;
    try {
      blob = kind === 'pdf' ? await buildPdf() : await buildZip();
    } catch (e) {
      alert('Gagal membuat file. Coba lagi dengan halaman lebih sedikit.');
    }
    hideBusy();
    exporting = false;
    if (blob) await deliver(blob, fileBase() + '.' + kind, kind === 'pdf' ? 'application/pdf' : 'application/zip');
  }

  async function newScan() {
    if (state.pages.length && !confirm('Hapus semua halaman dan mulai scan baru?')) return;
    state.pages.forEach((p) => { if (p.thumb) URL.revokeObjectURL(p.thumb); });
    state.pages = [];
    thumbGen++;
    await store.clear();
    saveMeta();
    updateCount(false);
    state.nameEdited = false;
    updateHome();
    T.locked = false; T.lockSig = null; T.lockQuad = null;
    show('cam');
  }

  // ---------- Petunjuk pasang di iPhone ----------
  function iosHint() {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = navigator.standalone === true ||
      (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
    if (ios && !standalone && lsGet('hint') !== '1') el.hint.hidden = false;
  }

  // ---------- Mulai ----------
  function bind() {
    document.addEventListener('pointerdown', initAudio, { passive: true });
    document.addEventListener('touchend', initAudio, { passive: true });

    el.shot.addEventListener('click', () => capture());
    // Ketuk di mana saja pada gambar kamera = potret (pengganti tombol volume, yang tidak bisa dibaca web).
    el.cam.addEventListener('click', (e) => { if (e.target === el.video || e.target === el.cam) capture(); });
    el.autoBtn.addEventListener('click', () => {
      state.auto = !state.auto;
      el.autoBtn.setAttribute('aria-checked', String(state.auto));
      T.anchor = null;
      setStatus();
    });
    el.doneBtn.addEventListener('click', () => show('res'));
    el.backBtn.addEventListener('click', () => show('cam'));
    el.homeBtn.addEventListener('click', () => show('home'));
    el.startScanBtn.addEventListener('click', () => show('cam'));
    el.importBtn.addEventListener('click', () => el.pick.click());
    el.recentDoc.addEventListener('click', () => show('res'));
    el.allDocsBtn.addEventListener('click', () => show('res'));
    el.navDocsBtn.addEventListener('click', () => show('res'));
    el.pick.addEventListener('change', () => {
      const files = [...el.pick.files];
      el.pick.value = '';
      importFiles(files);
    });
    el.hintClose.addEventListener('click', () => { el.hint.hidden = true; lsSet('hint', '1'); });

    el.filters.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.dataset.f === state.filter) return;
      state.filter = b.dataset.f;
      [...el.filters.children].forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      saveMeta();
      refreshThumbs();
    });
    el.name.addEventListener('input', () => { state.nameEdited = true; updateHome(); });
    el.pdfBtn.addEventListener('click', () => exportAs('pdf'));
    el.zipBtn.addEventListener('click', () => exportAs('zip'));
    el.newBtn.addEventListener('click', newScan);

    el.rotBtn.addEventListener('click', rotatePage);
    el.cropBtn.addEventListener('click', openCrop);
    el.cropCancel.addEventListener('click', closeCrop);
    el.cropSave.addEventListener('click', saveCrop);
    bindCrop();
    el.delBtn.addEventListener('click', deletePage);
    el.closeSheet.addEventListener('click', closeSheet);
    el.sheet.addEventListener('click', (e) => { if (e.target === el.sheet) closeSheet(); });
    el.readyBtn.addEventListener('click', sharePending);
    el.readyClose.addEventListener('click', () => { pending = null; el.ready.hidden = true; });

    bindGrid();

    // Kamera dimatikan saat app di latar belakang, dinyalakan lagi saat kembali.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopCam();
      else if (state.screen === 'cam') startCam();
    });
  }

  function init() {
    bind();
    show('home');
    restorePages();
    waitCv();
    iosHint();
    tick();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* tetap jalan tanpa offline */ });
    }
  }

  // Untuk pengujian deteksi dari konsol: kembalikan 4 sudut (skala 0..1) pada sebuah canvas.
  window.__lembarDetect = (canvas) => {
    const f = findQuad(canvas);
    return f.smallQuad ? f.smallQuad.map((p) => ({ x: p.x / f.k / canvas.width, y: p.y / f.k / canvas.height })) : null;
  };

  init();
})();
