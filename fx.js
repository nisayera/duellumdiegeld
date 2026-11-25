'use strict';
/* =========================================================
   Schätzpoker – Bewegung & Atmosphäre
   Alles hier ist Darstellung: Die Spiellogik in app.js funktioniert
   auch komplett ohne diese Datei. Bei „weniger Bewegung“ bleibt
   nur das Ergebnis stehen, ohne Wege.
   ========================================================= */
const FX = (() => {
  const mq = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const calm = () => mq.matches;
  const EASE = 'cubic-bezier(.16, 1, .3, 1)';
  let inVT = false;
  let queue = [];
  let rects = new Map();
  const tweenMem = new Map();

  /* ---------- Körnung: echtes Rauschen, einmal gerechnet ---------- */
  function grain() {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 180;
      const g = c.getContext('2d'); const img = g.createImageData(180, 180);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = Math.random() * 38;
      }
      g.putImageData(img, 0, 0);
      document.documentElement.style.setProperty('--grain', `url(${c.toDataURL('image/png')})`);
    } catch { /* ohne Körnung */ }
  }

  /* ---------- FLIP: Dinge, die ihren Platz wechseln, gleiten ---------- */
  function capture() {
    rects = new Map();
    document.querySelectorAll('[data-flip]').forEach((el) => rects.set(el.dataset.flip, el.getBoundingClientRect()));
  }
  function flip() {
    if (calm()) return;
    document.querySelectorAll('[data-flip]').forEach((el) => {
      const a = rects.get(el.dataset.flip); if (!a) return;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left; const dy = a.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], { duration: 520, easing: EASE });
    });
  }

  /* ---------- Zahlen zählen von ihrem alten Wert zum neuen ---------- */
  const nf = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 3 });
  function tweens() {
    document.querySelectorAll('[data-tween]').forEach((el) => {
      const key = el.dataset.tween; const to = Number(el.dataset.value);
      if (!isFinite(to)) return;
      const from = tweenMem.has(key) ? tweenMem.get(key) : to;
      tweenMem.set(key, to);
      if (from === to || calm()) return;
      const delay = Number(el.dataset.delay || 0);
      const t0 = performance.now() + delay; const dur = 620;
      el.textContent = nf.format(from);
      el.classList.add('ticking');
      const step = (t) => {
        if (!el.isConnected) return;
        const k = Math.max(0, Math.min(1, (t - t0) / dur)); const e = 1 - Math.pow(1 - k, 3);
        el.textContent = nf.format(Math.round(from + (to - from) * e));
        if (k < 1) requestAnimationFrame(step); else el.classList.remove('ticking');
      };
      requestAnimationFrame(step);
    });
  }

  /* ---------- Jetons fliegen über den Filz ---------- */
  const CHIP = ['#e0443e', '#4f7be8', '#f3ead7', '#1f8a5b', '#141016'];
  function anchor(id) {
    if (id === 'pot') return document.querySelector('.pot-pile');
    return document.querySelector(`[data-pid="${id}"] .seat-anchor`);
  }
  function chips(from, to, amount, unit) {
    queue.push({ from, to, n: Math.max(1, Math.min(6, Math.ceil((amount || 1) / Math.max(1, unit || 1)))) });
  }
  function flyAll() {
    const list = queue; queue = [];
    if (calm()) return;
    list.forEach((job, j) => {
      const a = anchor(job.from); const b = anchor(job.to);
      if (!a || !b) return;
      const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect();
      const x0 = ra.left + ra.width / 2; const y0 = ra.top + ra.height / 2;
      const x1 = rb.left + rb.width / 2; const y1 = rb.top + rb.height / 2;
      for (let i = 0; i < job.n; i++) {
        const c = document.createElement('i');
        c.className = 'fly-chip'; c.setAttribute('aria-hidden', 'true');
        c.style.setProperty('--c', CHIP[(i + j) % CHIP.length]);
        c.style.left = x0 + 'px'; c.style.top = y0 + 'px';
        document.body.appendChild(c);
        const lift = -40 - Math.random() * 40; const jitter = (Math.random() - .5) * 18;
        const dx = x1 - x0 + jitter; const dy = y1 - y0 + (Math.random() - .5) * 10;
        const anim = c.animate([
          { transform: 'translate(-50%,-50%) scale(.6) rotateX(0deg)', opacity: 0 },
          { transform: `translate(calc(-50% + ${dx * .5}px), calc(-50% + ${dy * .5 + lift}px)) scale(1.08) rotateX(320deg)`, opacity: 1, offset: .5 },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.9) rotateX(720deg)`, opacity: 1, offset: .92 },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.9) rotateX(720deg)`, opacity: 0 }
        ], { duration: 640 + i * 40, delay: i * 55 + j * 90, easing: 'cubic-bezier(.3, .7, .2, 1)', fill: 'backwards' });
        anim.onfinish = () => c.remove(); anim.oncancel = () => c.remove();
      }
      if (job.to === 'pot') b.animate([{ scale: 1 }, { scale: 1.12 }, { scale: 1 }], { duration: 320, delay: 520 + j * 90, easing: EASE });
    });
  }

  /* ---------- Konfetti aus Jetons und Papier ---------- */
  function confetti(el, amount = 140) {
    if (calm() || !el) return;
    const r = el.getBoundingClientRect();
    const cv = document.createElement('canvas'); cv.className = 'confetti'; cv.setAttribute('aria-hidden', 'true');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    document.body.appendChild(cv);
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const cols = ['#d9b25f', '#f3ead7', '#e0443e', '#4f7be8', '#f0cf86', '#1f8a5b'];
    const ps = Array.from({ length: amount }, (_, i) => {
      const ang = -Math.PI / 2 + (Math.random() - .5) * Math.PI * .95;
      const sp = 7 + Math.random() * 9;
      return {
        x: r.left + r.width * (.2 + Math.random() * .6), y: r.top + r.height * .5,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, rot: Math.random() * 6, vr: (Math.random() - .5) * .35,
        w: 6 + Math.random() * 8, h: 4 + Math.random() * 10, c: cols[i % cols.length], chip: i % 5 === 0, life: 0
      };
    });
    const t0 = performance.now();
    const tick = (t) => {
      const el2 = (t - t0) / 1000;
      g.clearRect(0, 0, innerWidth, innerHeight);
      ps.forEach((p) => {
        p.vy += .32; p.vx *= .985; p.vy *= .985; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        g.save(); g.translate(p.x, p.y); g.rotate(p.rot); g.globalAlpha = Math.max(0, 1 - Math.max(0, el2 - 1.6) / .8);
        g.fillStyle = p.c;
        if (p.chip) { g.beginPath(); g.ellipse(0, 0, 7, 7 * Math.abs(Math.cos(p.rot * 2)), 0, 0, Math.PI * 2); g.fill(); }
        else g.fillRect(-p.w / 2, -p.h / 2 * Math.abs(Math.cos(p.rot)), p.w, p.h * Math.abs(Math.cos(p.rot)));
        g.restore();
      });
      if (el2 < 2.4) requestAnimationFrame(tick); else cv.remove();
    };
    requestAnimationFrame(tick);
  }

  /* ---------- Die Auflösung: der Showmoment ---------- */
  let shownKey = '';
  function showtime() {
    const res = document.querySelector('.result[data-key]'); if (!res) return;
    const key = res.dataset.key;
    if (key === shownKey) { res.classList.add('settled'); return; }
    shownKey = key;
    if (calm()) { res.classList.add('settled'); return; }
    const game = document.querySelector('.game');
    game?.classList.add('showtime');
    res.classList.add('playing');
    const num = res.querySelector('.answer b[data-count]');
    if (num) {
      const target = Number(num.dataset.count); const final = num.textContent;
      const dec = (String(target).split('.')[1] || '').length;
      const t0 = performance.now() + 900; const dur = 1300;
      const step = (t) => {
        if (!num.isConnected) return;
        const k = Math.max(0, Math.min(1, (t - t0) / dur)); const e = 1 - Math.pow(1 - k, 4);
        const v = target * e;
        num.textContent = k < 1 ? (num.dataset.year ? String(Math.round(v)) : nf.format(Number(v.toFixed(dec)))) : final;
        num.style.filter = k < 1 ? `blur(${(1 - e) * 6}px)` : '';
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    setTimeout(() => {
      if (!res.isConnected) return;
      game?.classList.remove('showtime');
      res.classList.add('settled');
      confetti(res.querySelector('.ranking li.best') || res.querySelector('.foldwin') || res.querySelector('.answer'));
    }, 2350);
    setTimeout(() => res.isConnected && flyAll(), 2450);
  }

  /* ---------- Ablauf ---------- */
  function play() {
    if (inVT) return;
    flip(); tweens();
    if (document.querySelector('.result[data-key]')) showtime(); else flyAll();
    const end = document.querySelector('.end .winner');
    if (end && !end.dataset.done) { end.dataset.done = 1; setTimeout(() => confetti(end, 220), 500); }
  }
  // Phasenwechsel als Szenenwechsel (View Transitions), sonst sofort
  function transition(fn) {
    if (!document.startViewTransition || calm() || inVT) { fn(); return; }
    inVT = true;
    let vt;
    try { vt = document.startViewTransition(() => fn()); } catch { inVT = false; fn(); return; }
    vt.ready.catch(() => {});
    vt.finished.catch(() => {}).finally(() => { inVT = false; play(); });
  }

  grain();
  // Startbildschirm: Auftritt nur beim ersten Laden, nicht bei jeder Eingabe
  setTimeout(() => document.body.classList.add('intro-played'), 2600);
  return { capture, play, transition, chips, confetti, calm, get busy() { return inVT; } };
})();
