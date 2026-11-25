'use strict';
/* =========================================================
   Schätzpoker – Moderator-Webseite
   Ablauf pro Runde:
   Blinds → Frage → Setzrunde 1 → Hinweis 1 → Setzrunde 2 → Hinweis 2 → Setzrunde 3 → Aufdecken → Auflösung
   ========================================================= */

const LS_STATE = 'sp_state_v1';
const LS_CUSTOM = 'sp_custom_q_v1';
const LS_PREFS = 'sp_prefs_v1';

const PHASES = ['intro', 'question', 'bet0', 'hint1', 'bet1', 'hint2', 'bet2', 'showdown', 'result'];
const PHASE_LABEL = {
  intro: 'Blinds', question: 'Frage', bet0: 'Setzen 1', hint1: 'Hinweis 1', bet1: 'Setzen 2',
  hint2: 'Hinweis 2', bet2: 'Setzen 3', showdown: 'Aufdecken', result: 'Auflösung'
};

const DEFAULT_PREFS = {
  mode: 'moderator',
  players: ['', '', '', ''],
  startStack: 1000,
  schedule: '25/50, 50/100, 75/150, 100/200, 150/300, 200/400, 300/600, 400/800, 500/1000, 750/1500, 1000/2000',
  levelEvery: 3,
  rounds: 0,
  timer: 60,
  tts: false,
  builtin: true
};

let S = null;          // aktueller Spielzustand
let history = [];      // Undo-Stack
let modal = null;      // offenes Modal
let timer = { left: 0, int: null };

/* ---------- Helfer ---------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 3 });
const fmt = (n) => (n == null || isNaN(n) ? '–' : nf.format(n));
const fmtYear = (q, n) => (q.unit === '' && Number.isInteger(n) && n > 999 && n < 2200 ? String(n) : fmt(n));

function parseNum(s) {
  if (s == null) return NaN;
  s = String(s).trim().replace(/[\s']/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}
function parseSchedule(str) {
  return String(str).split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = x.match(/^(\d+)\s*\/\s*(\d+)$/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  }).filter(Boolean);
}
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function load(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } }
function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* egal */ } }

function getPrefs() { return Object.assign({}, DEFAULT_PREFS, load(LS_PREFS, {})); }
function getCustom() { return load(LS_CUSTOM, []); }
function questionPool(builtin) {
  const custom = getCustom();
  return (builtin ? (window.BUILTIN_QUESTIONS || []) : []).concat(custom);
}

/* ---------- Sprachausgabe & Ton ---------- */
function speak(text) {
  if (!S || !S.settings.tts || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'de-DE';
  const v = speechSynthesis.getVoices().find((x) => x.lang && x.lang.startsWith('de'));
  if (v) u.voice = v;
  u.rate = 1;
  speechSynthesis.speak(u);
}
function beep(freq = 880, dur = 0.18, times = 1) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = freq; o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i * (dur + 0.08);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t); o.stop(t + dur + 0.02);
    }
  } catch { /* kein Audio */ }
}

/* ---------- Zustand speichern / Undo ---------- */
function save() { if (S) store(LS_STATE, S); else localStorage.removeItem(LS_STATE); }
function snap() { history.push(JSON.stringify(S)); if (history.length > 80) history.shift(); }
function undo() {
  if (!history.length) return;
  S = JSON.parse(history.pop());
  stopTimer();
  save(); render();
}

/* ---------- Spieler / Positionen ---------- */
const isChips = () => S && S.settings.mode === 'chips';
const P = (idx) => S.players[idx];
const H = (p) => S.r.hand[p.id];
function seatNext(idx, pred) {
  const n = S.players.length;
  for (let k = 1; k <= n; k++) { const j = (idx + k + n) % n; if (pred(S.players[j], j)) return j; }
  return -1;
}
const inPlay = (p) => !p.out;
function inHand(p) { const h = S.r.hand[p.id]; return !!h && !h.folded; }
function canAct(p) { const h = S.r.hand[p.id]; return !!h && !h.folded && !h.allIn; }
function potTotal() { return Object.values(S.r.hand).reduce((s, h) => s + h.total, 0); }
function pot() { return S.r.result ? 0 : potTotal(); }
function levelFor(round) { return Math.min(Math.floor((round - 1) / S.settings.levelEvery), S.settings.schedule.length - 1); }

/* ---------- Spielstart ---------- */
function startGame(cfg) {
  const pool = questionPool(cfg.builtin);
  S = {
    screen: 'game',
    settings: {
      mode: cfg.mode, startStack: cfg.startStack, schedule: cfg.schedule, levelEvery: cfg.levelEvery,
      rounds: cfg.rounds, timer: cfg.timer, tts: cfg.tts
    },
    players: cfg.names.map((n, i) => ({ id: 'p' + i, name: n, stack: cfg.mode === 'chips' ? cfg.startStack : 0, out: false })),
    nextId: cfg.names.length,
    round: 0,
    dealer: -1,
    deck: shuffle(pool),
    deckPos: 0,
    r: null
  };
  history = [];
  newRound();
}

function newRound() {
  stopTimer();
  if (isChips()) {
    S.players.forEach((p) => { if (p.stack <= 0) p.out = true; });
  }
  const act = S.players.filter(inPlay);
  if ((isChips() && act.length < 2) || (S.settings.rounds && S.round >= S.settings.rounds)) return endGame();
  if (act.length < 2) return endGame();

  S.round++;
  const lvl = levelFor(S.round);
  const [sb, bb] = S.settings.schedule[lvl];
  const prevLvl = S.round > 1 ? levelFor(S.round - 1) : 0;
  S.dealer = seatNext(S.dealer < 0 ? S.players.length - 1 : S.dealer, inPlay);
  const heads = act.length === 2;
  const sbIdx = heads ? S.dealer : seatNext(S.dealer, inPlay);
  const bbIdx = seatNext(sbIdx, inPlay);

  if (S.deckPos >= S.deck.length) { S.deck = shuffle(S.deck); S.deckPos = 0; }
  const q = S.deck[S.deckPos++];

  S.r = {
    q, phase: 'intro', level: lvl, sb, bb, levelUp: S.round > 1 && lvl > prevLvl,
    sbIdx, bbIdx, hand: {}, currentBet: 0, minRaise: bb, toAct: -1, acted: [], betDone: false,
    estimates: {}, result: null, foldWin: null, nextLevelIn: S.settings.levelEvery - ((S.round - 1) % S.settings.levelEvery)
  };
  if (isChips()) {
    act.forEach((p) => { S.r.hand[p.id] = { inRound: 0, total: 0, folded: false, allIn: false }; });
    putChips(P(sbIdx), sb);
    putChips(P(bbIdx), bb);
    S.r.currentBet = Math.max(H(P(sbIdx)).inRound, H(P(bbIdx)).inRound);
  }
  S.screen = 'game';
  save(); render();
  announce();
}

function endGame() {
  stopTimer();
  S.screen = 'end';
  save(); render();
  if (isChips()) {
    const w = S.players.slice().sort((a, b) => b.stack - a.stack)[0];
    speak(`Spielende! ${w.name} gewinnt mit ${fmt(w.stack)} Chips.`);
  } else speak('Spielende! Danke fürs Mitspielen.');
}

/* ---------- Setz-Engine ---------- */
function putChips(p, amount) {
  const h = H(p);
  const a = Math.min(amount, p.stack);
  p.stack -= a; h.inRound += a; h.total += a;
  if (p.stack === 0) h.allIn = true;
  return a;
}
function bettingComplete() {
  const live = S.players.filter((p) => inHand(p));
  if (live.length <= 1) return true;
  const actors = live.filter(canAct);
  if (actors.length === 0) return true;
  // Nur noch einer kann setzen und muss nichts nachzahlen → niemand mehr, gegen den er setzen könnte
  if (actors.length === 1 && H(actors[0]).inRound >= S.r.currentBet) return true;
  return actors.every((p) => S.r.acted.includes(p.id) && H(p).inRound === S.r.currentBet);
}
function startBetting(k) {
  const r = S.r;
  if (k > 0) {
    Object.values(r.hand).forEach((h) => { h.inRound = 0; });
    r.currentBet = 0; r.minRaise = r.bb;
  }
  r.acted = [];
  r.betDone = false;
  const from = k === 0 ? r.bbIdx : S.dealer;
  r.toAct = seatNext(from, (p) => canAct(p));
  if (bettingComplete()) { r.betDone = true; r.toAct = -1; }
}
function afterAction(idx) {
  const r = S.r;
  const live = S.players.filter((p) => inHand(p));
  if (live.length === 1) return finishByFold(live[0]);
  if (bettingComplete()) { r.betDone = true; r.toAct = -1; beep(660, 0.12, 2); }
  else r.toAct = seatNext(idx, (p) => canAct(p));
  save(); render();
}
function act(type, amount) {
  const r = S.r; const idx = r.toAct; if (idx < 0) return;
  const p = P(idx); const h = H(p);
  snap();
  const toCall = r.currentBet - h.inRound;
  if (type === 'fold') {
    h.folded = true;
  } else if (type === 'call') {
    putChips(p, Math.max(0, toCall));
  } else if (type === 'raise') {
    const target = Math.min(amount, h.inRound + p.stack);
    if (target <= r.currentBet) { putChips(p, Math.max(0, toCall)); }
    else {
      const inc = target - r.currentBet;
      putChips(p, target - h.inRound);
      if (inc >= r.minRaise) r.minRaise = inc;
      r.currentBet = target;
      r.acted = [];
    }
  }
  if (!r.acted.includes(p.id)) r.acted.push(p.id);
  afterAction(idx);
}

function finishByFold(winner) {
  const r = S.r;
  const amount = potTotal();
  winner.stack += amount;
  r.foldWin = { id: winner.id, amount };
  r.result = { ranking: [], pots: [{ amount, winners: [winner.id] }] };
  r.phase = 'result';
  r.toAct = -1;
  stopTimer();
  save(); render();
  speak(`${winner.name} gewinnt den Pot von ${fmt(amount)}, alle anderen haben gepasst. Die richtige Antwort war ${spokenAnswer()}.`);
}

/* ---------- Auflösung / Side-Pots ---------- */
function resolveShowdown() {
  const r = S.r; const a = Number(r.q.a);
  const contenders = isChips() ? S.players.filter((p) => inHand(p)) : S.players.filter(inPlay);
  const ranking = contenders
    .filter((p) => !isNaN(r.estimates[p.id]))
    .map((p) => ({ id: p.id, est: r.estimates[p.id], dist: Math.abs(r.estimates[p.id] - a) }))
    .sort((x, y) => x.dist - y.dist);

  if (isChips()) {
    const missing = contenders.filter((p) => isNaN(r.estimates[p.id]));
    if (missing.length) { toast('Bitte Schätzungen eintragen für: ' + missing.map((p) => p.name).join(', ')); return; }
  }
  snap();
  const dist = Object.fromEntries(ranking.map((x) => [x.id, x.dist]));
  const pots = [];
  if (isChips()) {
    const all = S.players.filter((p) => r.hand[p.id]);
    const live = all.filter((p) => inHand(p));
    const levels = [...new Set(live.map((p) => H(p).total))].sort((x, y) => x - y);
    let prev = 0; let distributed = 0;
    levels.forEach((L, li) => {
      let slice = all.reduce((s, p) => s + Math.min(H(p).total, L) - Math.min(H(p).total, prev), 0);
      if (li === levels.length - 1) slice = potTotal() - distributed; // Rest (Sicherheitsnetz)
      const elig = live.filter((p) => H(p).total >= L);
      const best = Math.min(...elig.map((p) => dist[p.id]));
      const winners = elig.filter((p) => Math.abs(dist[p.id] - best) < 1e-9);
      // Reihenfolge ab Dealer für Restchips
      winners.sort((x, y) => seatOrder(x) - seatOrder(y));
      const share = Math.floor(slice / winners.length);
      let rest = slice - share * winners.length;
      winners.forEach((w) => { w.stack += share + (rest > 0 ? 1 : 0); if (rest > 0) rest--; });
      if (slice > 0) pots.push({ amount: slice, winners: winners.map((w) => w.id), refund: elig.length === 1 && levels.length > 1 && li === levels.length - 1 });
      distributed += slice; prev = L;
    });
  }
  r.result = { ranking, pots };
  r.phase = 'result';
  stopTimer();
  save(); render();
  let txt = `Die richtige Antwort lautet: ${spokenAnswer()}.`;
  if (ranking.length) {
    const best = ranking.filter((x) => Math.abs(x.dist - ranking[0].dist) < 1e-9).map((x) => byId(x.id).name);
    txt += ` Am nächsten dran: ${best.join(' und ')}.`;
  }
  speak(txt);
}
function seatOrder(p) {
  const n = S.players.length; const i = S.players.indexOf(p);
  return (i - S.dealer - 1 + n) % n;
}
const byId = (id) => S.players.find((p) => p.id === id);
function spokenAnswer() { const q = S.r.q; return `${fmtYear(q, Number(q.a))} ${q.unit || ''}`.trim(); }

/* ---------- Phasen-Steuerung ---------- */
function next() {
  const r = S.r;
  if (r.phase === 'result') { snap(); return newRound(); }
  if (r.phase === 'showdown') return resolveShowdown();
  if (isChips() && r.phase.startsWith('bet') && !r.betDone) { toast('Die Setzrunde ist noch nicht abgeschlossen.'); return; }
  snap();
  const i = PHASES.indexOf(r.phase);
  r.phase = PHASES[i + 1];
  if (r.phase.startsWith('bet') && isChips()) startBetting(Number(r.phase.slice(3)));
  if (r.phase !== 'question') stopTimer();
  save(); render();
  announce();
  if (r.phase === 'question' && S.settings.timer > 0) startTimer();
}
function announce() {
  const r = S.r; if (!r) return;
  const names = (i) => (i >= 0 ? P(i).name : '');
  switch (r.phase) {
    case 'intro':
      speak(`Runde ${S.round}. ${r.levelUp ? 'Achtung, die Blinds steigen! ' : ''}Small Blind ${fmt(r.sb)}, Big Blind ${fmt(r.bb)}. ${names(r.sbIdx)} setzt den Small Blind, ${names(r.bbIdx)} den Big Blind.`);
      break;
    case 'question': speak(`Die Frage lautet: ${r.q.q} Schreibt eure Schätzung verdeckt auf.`); break;
    case 'hint1': speak(`Erster Hinweis: ${r.q.h1}`); break;
    case 'hint2': speak(`Zweiter Hinweis: ${r.q.h2}`); break;
    case 'bet0': case 'bet1': case 'bet2': {
      const k = Number(r.phase.slice(3)) + 1;
      if (isChips()) speak(r.betDone ? `Setzrunde ${k} entfällt, es kann niemand mehr setzen.` : `Setzrunde ${k}. ${names(r.toAct)} ist am Zug.`);
      else speak(`Setzrunde ${k}. Es beginnt ${names(firstToActModerator())}.`);
      break;
    }
    case 'showdown': speak('Showdown! Deckt eure Schätzungen auf.'); break;
  }
}
function firstToActModerator() {
  const r = S.r; const k = Number(r.phase.slice(3));
  return seatNext(k === 0 ? r.bbIdx : S.dealer, inPlay);
}
function swapQuestion() {
  snap();
  if (S.deckPos >= S.deck.length) { S.deck = shuffle(S.deck); S.deckPos = 0; }
  S.r.q = S.deck[S.deckPos++];
  save(); render(); announce();
}

/* ---------- Timer ---------- */
function startTimer(sec) {
  stopTimer();
  timer.left = sec || S.settings.timer || 60;
  timer.int = setInterval(() => {
    timer.left--;
    const el = $('#timer'); if (el) { el.textContent = timer.left; el.classList.toggle('urgent', timer.left <= 10); }
    if (timer.left <= 5 && timer.left > 0) beep(660, 0.08);
    if (timer.left <= 0) { stopTimer(); beep(440, 0.5, 2); speak('Die Zeit ist um. Stifte weg!'); render(); }
  }, 1000);
  render();
}
function stopTimer() { if (timer.int) clearInterval(timer.int); timer.int = null; }

/* ---------- Toast ---------- */
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2800);
}

/* =========================================================
   RENDERING
   ========================================================= */
function render() {
  const app = $('#app');
  if (!S || S.screen === 'setup') app.innerHTML = renderSetup();
  else if (S.screen === 'end') app.innerHTML = renderEnd();
  else app.innerHTML = renderGame();
  $('#modal-root').innerHTML = modal ? renderModal() : '';
  const focus = document.querySelector('[data-autofocus]');
  if (focus && !modal) focus.focus({ preventScroll: true });
}

/* ---------- Setup ---------- */
function renderSetup() {
  const pr = getPrefs();
  const pool = questionPool(pr.builtin).length;
  const saved = load(LS_STATE, null);
  const resume = saved && saved.screen === 'game' ? `
    <div class="resume">
      <div><b>Laufendes Spiel gefunden</b><span>Runde ${saved.round} · ${saved.players.length} Spieler · ${saved.settings.mode === 'chips' ? 'digitale Chips' : 'nur Moderator'}</span></div>
      <button class="btn gold" data-act="resume">Fortsetzen</button>
    </div>` : '';
  const players = pr.players.map((n, i) => `
      <div class="player-row">
        <span class="seat">${i + 1}</span>
        <input type="text" maxlength="18" placeholder="Spieler ${i + 1}" value="${esc(n)}" data-pref-player="${i}">
        <button class="icon-btn" title="Entfernen" data-act="rm-player" data-i="${i}" ${pr.players.length <= 2 ? 'disabled' : ''}>✕</button>
      </div>`).join('');
  return `
  <div class="setup">
    <header class="hero">
      <div class="logo-chip">?</div>
      <h1>Schätz&shy;poker</h1>
      <p class="tag">Quiz trifft Poker. Wer weiß es? Wer blufft?</p>
    </header>
    ${resume}
    <section class="panel">
      <h2>Modus</h2>
      <div class="mode-pick">
        <button class="mode ${pr.mode === 'moderator' ? 'on' : ''}" data-act="mode" data-mode="moderator">
          <b>Nur Moderator</b><span>Ihr spielt mit echten Chips. Die Seite sagt Blinds, Fragen und Hinweise an.</span>
        </button>
        <button class="mode ${pr.mode === 'chips' ? 'on' : ''}" data-act="mode" data-mode="chips">
          <b>Mit digitalen Chips</b><span>Zusätzlich verwaltet die Seite Stacks, Einsätze und den Pot und verteilt ihn automatisch.</span>
        </button>
      </div>
    </section>
    <section class="panel">
      <h2>Spieler <small>(Sitzreihenfolge im Uhrzeigersinn)</small></h2>
      <div class="players">${players}</div>
      <button class="btn ghost" data-act="add-player" ${pr.players.length >= 10 ? 'disabled' : ''}>+ Spieler hinzufügen</button>
    </section>
    <section class="panel grid2">
      <h2 class="full">Einstellungen</h2>
      <label class="${pr.mode === 'chips' ? '' : 'dim'}">Startchips pro Spieler
        <input type="number" min="1" step="1" value="${pr.startStack}" data-pref="startStack"></label>
      <label>Blinds steigen alle … Runden
        <input type="number" min="1" step="1" value="${pr.levelEvery}" data-pref="levelEvery"></label>
      <label class="full">Blind-Stufen (Small/Big)
        <input type="text" value="${esc(pr.schedule)}" data-pref="schedule"></label>
      <label>Anzahl Fragen <small>(0 = bis einer alles hat / offen)</small>
        <input type="number" min="0" step="1" value="${pr.rounds}" data-pref="rounds"></label>
      <label>Schreib-Timer in Sekunden <small>(0 = aus)</small>
        <input type="number" min="0" step="5" value="${pr.timer}" data-pref="timer"></label>
      <label class="check"><input type="checkbox" ${pr.tts ? 'checked' : ''} data-pref="tts"> Sprachausgabe – die Seite liest Fragen &amp; Hinweise vor</label>
      <label class="check"><input type="checkbox" ${pr.builtin ? 'checked' : ''} data-pref="builtin"> Eingebaute Fragen verwenden (${(window.BUILTIN_QUESTIONS || []).length})</label>
    </section>
    <section class="panel row">
      <div><b>${pool}</b> Fragen im Topf · <b>${getCustom().length}</b> eigene</div>
      <div class="row-btns">
        <button class="btn ghost" data-act="open" data-modal="questions">Fragen verwalten</button>
        <button class="btn ghost" data-act="open" data-modal="rules">Spielregeln</button>
      </div>
    </section>
    <button class="btn gold big start" data-act="start">Spiel starten</button>
    <p class="foot">Tipp: Am besten auf einem Fernseher oder Laptop anzeigen und mit <kbd>Leertaste</kbd> weiterschalten.</p>
  </div>`;
}

/* ---------- Spielansicht ---------- */
function renderGame() {
  const r = S.r;
  const lvl = r.level + 1;
  const nextUp = r.level < S.settings.schedule.length - 1
    ? (r.nextLevelIn === 1 ? 'steigt nächste Runde' : `steigt in ${r.nextLevelIn} Runden`) : 'Maximum';
  const roundsTxt = S.settings.rounds ? `${S.round} / ${S.settings.rounds}` : S.round;
  return `
  <div class="game ${isChips() ? 'chips' : 'mod'}">
    <header class="bar">
      <div class="brand"><span class="logo-chip sm">?</span>Schätzpoker</div>
      <div class="stat"><small>Runde</small><b>${roundsTxt}</b></div>
      <div class="stat blinds ${r.levelUp && r.phase === 'intro' ? 'flash' : ''}"><small>Blinds · Stufe ${lvl}</small><b>${fmt(r.sb)} / ${fmt(r.bb)}</b><em>${nextUp}</em></div>
      ${isChips() ? `<div class="stat"><small>Pot</small><b class="pot-num">${fmt(pot())}</b></div>` : ''}
      <nav>
        <button class="icon-btn" title="Rückgängig" data-act="undo" ${history.length ? '' : 'disabled'}>↶</button>
        <button class="icon-btn" title="Spieler" data-act="open" data-modal="players">👥</button>
        <button class="icon-btn" title="Regeln" data-act="open" data-modal="rules">?</button>
        <button class="icon-btn" title="Sprachausgabe" data-act="tts">${S.settings.tts ? '🔊' : '🔈'}</button>
        <button class="icon-btn" title="Vollbild" data-act="fullscreen">⛶</button>
        <button class="icon-btn" title="Menü" data-act="open" data-modal="menu">☰</button>
      </nav>
    </header>
    <main>
      <section class="stage">${renderStage()}</section>
      <aside class="table">${renderTable()}</aside>
    </main>
    <footer class="steps">${PHASES.map((ph, i) => {
      const cur = PHASES.indexOf(r.phase);
      return `<span class="${i < cur ? 'done' : ''} ${i === cur ? 'cur' : ''}">${PHASE_LABEL[ph]}</span>`;
    }).join('')}</footer>
  </div>`;
}

function questionBlock(small) {
  const r = S.r; const ph = PHASES.indexOf(r.phase);
  const hints = [];
  if (ph >= PHASES.indexOf('hint1')) hints.push(['1', r.q.h1]);
  if (ph >= PHASES.indexOf('hint2')) hints.push(['2', r.q.h2]);
  return `
    <div class="qcard ${small ? 'small' : ''}">
      <div class="qlabel">Frage ${S.round}${r.q.unit ? ` · Antwort in <b>${esc(r.q.unit)}</b>` : ''}</div>
      <div class="qtext">${esc(r.q.q)}</div>
    </div>
    ${hints.length ? `<div class="hints">${hints.map(([n, t]) => `<div class="hint ${r.phase === 'hint' + n ? 'new' : ''}"><span>Hinweis ${n}</span>${esc(t)}</div>`).join('')}</div>` : ''}`;
}

function primary(label, extra = '') {
  return `<button class="btn gold big primary" data-act="next" ${extra}>${label}</button>`;
}

function renderStage() {
  const r = S.r;
  const name = (i) => (i >= 0 ? esc(P(i).name) : '–');
  switch (r.phase) {
    case 'intro':
      return `
        <div class="intro">
          ${r.levelUp ? '<div class="levelup">Die Blinds steigen!</div>' : ''}
          <div class="kicker">Runde ${S.round}</div>
          <div class="blind-big"><div><small>Small Blind</small><b>${fmt(r.sb)}</b><span>${name(r.sbIdx)}</span></div>
          <div><small>Big Blind</small><b>${fmt(r.bb)}</b><span>${name(r.bbIdx)}</span></div></div>
          <p class="sub">Dealer-Button: <b>${name(S.dealer)}</b>${isChips() ? ' · Blinds wurden automatisch gesetzt' : ' · Bitte Blinds in die Mitte legen'}</p>
          ${primary('Frage stellen', 'data-autofocus')}
        </div>`;
    case 'question':
      return `
        ${questionBlock(false)}
        <div class="write-note">✍️ Jeder schreibt seine Schätzung <b>verdeckt</b> auf.</div>
        <div class="tools">
          ${timer.int ? `<div class="timer-wrap"><span id="timer" class="timer ${timer.left <= 10 ? 'urgent' : ''}">${timer.left}</span><button class="btn ghost sm" data-act="timer-stop">Stopp</button></div>`
            : `<button class="btn ghost" data-act="timer-start">⏱ Timer ${S.settings.timer || 60} s</button>`}
          <button class="btn ghost" data-act="swap">↻ Andere Frage</button>
        </div>
        ${primary('Setzrunde 1 starten', 'data-autofocus')}`;
    case 'hint1': case 'hint2':
      return `${questionBlock(false)}${primary(`Setzrunde ${r.phase === 'hint1' ? 2 : 3} starten`, 'data-autofocus')}`;
    case 'bet0': case 'bet1': case 'bet2':
      return `${questionBlock(true)}${renderBetting()}`;
    case 'showdown': return renderShowdown();
    case 'result': return renderResult();
  }
  return '';
}

function renderBetting() {
  const r = S.r; const k = Number(r.phase.slice(3)) + 1;
  const nextLabel = k === 3 ? 'Zum Showdown' : `Hinweis ${k} aufdecken`;
  if (!isChips()) {
    const first = firstToActModerator();
    return `
      <div class="betbox">
        <div class="bet-title">Setzrunde ${k} <small>von 3</small></div>
        <p class="sub">Es beginnt <b>${esc(P(first).name)}</b>${k === 1 ? ' (links vom Big Blind)' : ' (links vom Dealer)'}.<br>Passen · Checken · Mitgehen · Erhöhen · All-in</p>
        ${primary(`Setzrunde beendet → ${nextLabel}`, 'data-autofocus')}
      </div>`;
  }
  if (r.betDone) {
    const live = S.players.filter((p) => inHand(p));
    const allin = live.filter((p) => !H(p).allIn).length <= 1;
    return `
      <div class="betbox done">
        <div class="bet-title">Setzrunde ${k} abgeschlossen</div>
        ${allin && live.length > 1 ? '<p class="sub">Niemand kann mehr setzen – die Hinweise kommen trotzdem.</p>' : ''}
        ${primary(nextLabel, 'data-autofocus')}
      </div>`;
  }
  const p = P(r.toAct); const h = H(p);
  const toCall = Math.min(r.currentBet - h.inRound, p.stack);
  const maxTo = h.inRound + p.stack;
  const minTo = Math.min(r.currentBet === 0 ? r.bb : r.currentBet + r.minRaise, maxTo);
  const canRaise = maxTo > r.currentBet && p.stack > toCall;
  const roundTo = (x) => Math.max(minTo, Math.min(maxTo, Math.round(x / r.sb) * r.sb));
  const potNow = pot();
  const half = roundTo(r.currentBet + (potNow + toCall) / 2);
  const full = roundTo(r.currentBet + potNow + toCall);
  return `
    <div class="betbox">
      <div class="bet-title">Setzrunde ${k} <small>von 3</small></div>
      <div class="actor">
        <div class="actor-name">${esc(p.name)} <span>ist am Zug</span></div>
        <div class="actor-meta">Stack <b>${fmt(p.stack)}</b> · gesetzt <b>${fmt(h.inRound)}</b>${toCall > 0 ? ` · zu zahlen <b>${fmt(toCall)}</b>` : ''}</div>
      </div>
      <div class="actions">
        <button class="btn red" data-act="fold">Passen</button>
        ${toCall <= 0
          ? `<button class="btn green" data-act="call" data-autofocus>Checken</button>`
          : `<button class="btn green" data-act="call" data-autofocus>${toCall >= p.stack ? 'All-in mitgehen' : 'Mitgehen'} ${fmt(toCall)}</button>`}
      </div>
      ${canRaise ? `
      <div class="raise">
        <div class="raise-row">
          <label>${r.currentBet === 0 ? 'Setzen' : 'Erhöhen auf'}
            <input id="raise-to" type="number" min="${minTo}" max="${maxTo}" step="${r.sb}" value="${minTo}"></label>
          <button class="btn gold" data-act="raise">${r.currentBet === 0 ? 'Setzen' : 'Erhöhen'}</button>
        </div>
        <div class="quick">
          <button class="chip-btn" data-act="preset" data-v="${minTo}">Min ${fmt(minTo)}</button>
          <button class="chip-btn" data-act="preset" data-v="${half}">½ Pot ${fmt(half)}</button>
          <button class="chip-btn" data-act="preset" data-v="${full}">Pot ${fmt(full)}</button>
          <button class="chip-btn allin" data-act="allin">All-in ${fmt(maxTo)}</button>
        </div>
      </div>` : ''}
    </div>`;
}

function renderShowdown() {
  const r = S.r;
  const list = isChips() ? S.players.filter((p) => inHand(p)) : S.players.filter(inPlay);
  return `
    ${questionBlock(true)}
    <div class="showdown">
      <div class="bet-title">Showdown – Schätzungen aufdecken!</div>
      <p class="sub">${isChips() ? 'Tragt die Schätzungen aller Spieler ein, die noch dabei sind.' : 'Optional: Schätzungen eintragen, dann zeigt die Seite, wer am nächsten dran war.'}</p>
      <div class="est-list">
        ${list.map((p, i) => `
          <label class="est"><span>${esc(p.name)}</span>
            <input type="text" inputmode="decimal" placeholder="Schätzung" value="${isNaN(r.estimates[p.id]) || r.estimates[p.id] == null ? '' : String(r.estimates[p.id]).replace('.', ',')}" data-est="${p.id}" ${i === 0 ? 'data-autofocus' : ''}>
            ${r.q.unit ? `<em>${esc(r.q.unit)}</em>` : ''}</label>`).join('')}
      </div>
      ${primary('Lösung aufdecken')}
    </div>`;
}

function renderResult() {
  const r = S.r; const q = r.q; const res = r.result || { ranking: [], pots: [] };
  const rank = res.ranking;
  const bestDist = rank.length ? rank[0].dist : null;
  const lastRound = (S.settings.rounds && S.round >= S.settings.rounds);
  return `
    <div class="result">
      <div class="qtext sm">${esc(q.q)}</div>
      <div class="answer"><small>Die richtige Antwort</small><b>${fmtYear(q, Number(q.a))}</b><span>${esc(q.unit || '')}</span></div>
      ${q.info ? `<p class="info">${esc(q.info)}</p>` : ''}
      ${r.foldWin ? `<div class="foldwin"><b>${esc(byId(r.foldWin.id).name)}</b> gewinnt <b>${fmt(r.foldWin.amount)}</b> – alle anderen haben gepasst.</div>` : ''}
      ${rank.length ? `<ol class="ranking">${rank.map((x) => `
          <li class="${Math.abs(x.dist - bestDist) < 1e-9 ? 'best' : ''}">
            <span class="n">${esc(byId(x.id).name)}</span>
            <span class="e">${fmtYear(q, x.est)}</span>
            <span class="d">${x.dist === 0 ? 'exakt!' : '± ' + fmt(x.dist)}</span>
          </li>`).join('')}</ol>` : ''}
      ${isChips() && !r.foldWin && res.pots.length ? `<div class="payouts">${res.pots.map((pt, i) => `
          <div><small>${res.pots.length > 1 ? (i === 0 ? 'Hauptpot' : pt.refund ? 'Rückgabe' : `Side-Pot ${i}`) : 'Pot'}</small>
          <b>${fmt(pt.amount)}</b> → ${pt.winners.map((id) => esc(byId(id).name)).join(' &amp; ')}</div>`).join('')}</div>` : ''}
      ${!isChips() && rank.length ? `<p class="sub">Der Pot geht an <b>${rank.filter((x) => Math.abs(x.dist - bestDist) < 1e-9).map((x) => esc(byId(x.id).name)).join(' &amp; ')}</b> (bei Side-Pots: nur wer mitgegangen ist).</p>` : ''}
      ${primary(lastRound ? 'Zur Endwertung' : 'Nächste Runde', 'data-autofocus')}
    </div>`;
}

function renderTable() {
  const r = S.r;
  const rows = S.players.map((p, i) => {
    const h = r.hand[p.id];
    const marks = [i === S.dealer ? '<i class="m d">D</i>' : '', i === r.sbIdx ? '<i class="m sb">SB</i>' : '', i === r.bbIdx ? '<i class="m bb">BB</i>' : ''].join('');
    let status = '';
    if (p.out) status = 'raus';
    else if (h && h.folded) status = 'gepasst';
    else if (h && h.allIn) status = 'all-in';
    const turn = isChips() && r.toAct === i && r.phase.startsWith('bet') && !r.betDone;
    return `
      <li class="${p.out ? 'out' : ''} ${h && h.folded ? 'folded' : ''} ${turn ? 'turn' : ''}">
        <div class="pn"><span class="nm">${esc(p.name)}</span>${marks}</div>
        ${isChips() && !p.out ? `<div class="pv"><span class="stack">${fmt(p.stack)}</span>${h && h.inRound && !r.result ? `<span class="bet">${fmt(h.inRound)}</span>` : ''}</div>` : ''}
        ${status ? `<div class="st">${status}</div>` : ''}
      </li>`;
  }).join('');
  return `
    <h3>${isChips() ? 'Tisch' : 'Sitzordnung'}</h3>
    <ul class="seats">${rows}</ul>
    ${isChips() ? `<div class="pot-box"><small>Pot</small><b>${fmt(pot())}</b>${r.currentBet ? `<span>aktueller Einsatz ${fmt(r.currentBet)}</span>` : ''}</div>` : ''}`;
}

/* ---------- Endbildschirm ---------- */
function renderEnd() {
  const list = S.players.slice().sort((a, b) => b.stack - a.stack);
  return `
    <div class="end">
      <div class="logo-chip">★</div>
      <h1>Spielende</h1>
      ${isChips() ? `
        <div class="winner">${esc(list[0].name)}</div>
        <p class="sub">gewinnt mit <b>${fmt(list[0].stack)}</b> Chips</p>
        <ol class="ranking final">${list.map((p) => `<li><span class="n">${esc(p.name)}</span><span class="e">${fmt(p.stack)}</span></li>`).join('')}</ol>`
        : `<p class="sub">${S.round} Runden gespielt. Zählt eure Chips – wer hat am meisten?</p>`}
      <div class="row-btns center">
        <button class="btn ghost" data-act="undo" ${history.length ? '' : 'disabled'}>↶ Zurück</button>
        <button class="btn gold big" data-act="new-game">Neues Spiel</button>
      </div>
    </div>`;
}

/* ---------- Modals ---------- */
function renderModal() {
  let body = '';
  if (modal === 'rules') body = `
    <h2>Spielregeln</h2>
    <ol class="rules">
      <li><b>Blinds:</b> Der Dealer-Button wandert jede Runde eins weiter. Links vom Dealer setzt der Small Blind, danach der Big Blind. Die Blinds steigen in festen Abständen.</li>
      <li><b>Frage:</b> Es wird eine Schätzfrage gestellt. Jeder schreibt seine Antwort <b>verdeckt</b> auf. Danach wird nichts mehr geändert.</li>
      <li><b>Setzrunde 1:</b> Beginnt links vom Big Blind. Passen, Mitgehen oder Erhöhen wie beim Poker (No-Limit).</li>
      <li><b>Hinweis 1</b> wird aufgedeckt → <b>Setzrunde 2</b> (beginnt links vom Dealer).</li>
      <li><b>Hinweis 2</b> wird aufgedeckt → <b>Setzrunde 3</b>.</li>
      <li><b>Showdown:</b> Alle, die noch dabei sind, decken ihre Schätzung auf. Dann wird die richtige Antwort gezeigt.</li>
      <li><b>Gewinner:</b> Wer am nächsten dran ist, gewinnt den Pot. Bei Gleichstand wird geteilt. Wer All-in ist, kann nur so viel gewinnen, wie er selbst eingesetzt hat (Side-Pot).</li>
      <li>Passen alle anderen, gewinnt der letzte Spieler den Pot sofort – ohne aufzudecken.</li>
      <li>Wer keine Chips mehr hat, scheidet aus. Gewonnen hat, wer am Ende alle Chips hat (oder nach der letzten Frage die meisten).</li>
    </ol>`;
  else if (modal === 'menu') body = `
    <h2>Menü</h2>
    <div class="menu-list">
      <button class="btn ghost" data-act="skip-round">Runde abbrechen &amp; neue Frage</button>
      <button class="btn ghost" data-act="end-game">Spiel jetzt beenden</button>
      <button class="btn red" data-act="to-setup">Zurück zum Start (Spiel bleibt gespeichert)</button>
    </div>
    <p class="sub small">Hinweis: „Runde abbrechen“ gibt im Chip-Modus alle Einsätze dieser Runde zurück.</p>`;
  else if (modal === 'players') body = renderPlayersModal();
  else if (modal === 'questions') body = renderQuestionsModal();
  return `<div class="modal-bg" data-act="close-bg"><div class="modal" role="dialog">
    <button class="icon-btn close" data-act="close">✕</button>${body}</div></div>`;
}

function renderPlayersModal() {
  const rows = S.players.map((p) => `
    <div class="pm-row ${p.out ? 'out' : ''}">
      <input type="text" value="${esc(p.name)}" data-pname="${p.id}" maxlength="18">
      ${isChips() ? `<input type="number" value="${p.stack}" min="0" step="1" data-pstack="${p.id}" title="Stack (Chips vor dieser Runde nicht eingerechnet)">` : ''}
      <button class="btn sm ${p.out ? 'green' : 'ghost'}" data-act="toggle-out" data-id="${p.id}">${p.out ? 'Wieder rein' : 'Ausscheiden'}</button>
    </div>`).join('');
  return `
    <h2>Spieler</h2>
    <p class="sub small">Änderungen an Stacks gelten sofort. Ausgeschiedene / neue Spieler werden ab der nächsten Runde berücksichtigt.</p>
    <div class="pm">${rows}</div>
    <div class="row-btns">
      <input type="text" id="new-player" placeholder="Neuer Spieler" maxlength="18">
      <button class="btn gold" data-act="add-live-player">Hinzufügen</button>
    </div>`;
}

function renderQuestionsModal() {
  const custom = getCustom();
  return `
    <h2>Eigene Fragen</h2>
    <p class="sub small">Eingebaute Fragen werden hier absichtlich nicht angezeigt – sonst kennt der Gastgeber alle Antworten 😉</p>
    <form class="qform" data-form="addq">
      <label class="full">Frage<input name="q" required placeholder="Wie viele … ?"></label>
      <label>Antwort (Zahl)<input name="a" required inputmode="decimal" placeholder="z. B. 1234 oder 7,5"></label>
      <label>Einheit<input name="unit" placeholder="Meter, Jahre … (leer bei Jahreszahl)"></label>
      <label class="full">Hinweis 1<input name="h1" required></label>
      <label class="full">Hinweis 2<input name="h2" required></label>
      <label class="full">Info bei Auflösung (optional)<input name="info"></label>
      <button class="btn gold full" type="submit">Frage speichern</button>
    </form>
    <div class="qlist">${custom.length ? custom.map((q) => `
      <div class="qitem"><div><b>${esc(q.q)}</b><span>${fmt(q.a)} ${esc(q.unit || '')}</span></div>
      <button class="icon-btn" data-act="del-q" data-id="${esc(q.id)}">✕</button></div>`).join('') : '<p class="sub small">Noch keine eigenen Fragen.</p>'}</div>
    <div class="row-btns">
      <button class="btn ghost" data-act="export-q">Exportieren (JSON)</button>
      <label class="btn ghost file">Importieren<input type="file" accept=".json,application/json" data-import></label>
    </div>`;
}

/* =========================================================
   EVENTS
   ========================================================= */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const a = el.dataset.act;
  if (a === 'close-bg' && e.target !== el) return;
  const pr = getPrefs();
  switch (a) {
    case 'mode': pr.mode = el.dataset.mode; store(LS_PREFS, pr); render(); break;
    case 'add-player': pr.players.push(''); store(LS_PREFS, pr); render(); $(`[data-pref-player="${pr.players.length - 1}"]`)?.focus(); break;
    case 'rm-player': pr.players.splice(Number(el.dataset.i), 1); store(LS_PREFS, pr); render(); break;
    case 'start': {
      const names = pr.players.map((n, i) => n.trim() || `Spieler ${i + 1}`);
      const schedule = parseSchedule(pr.schedule);
      if (names.length < 2) return toast('Mindestens 2 Spieler.');
      if (!schedule.length) return toast('Blind-Stufen ungültig. Format: 25/50, 50/100, …');
      if (!questionPool(pr.builtin).length) return toast('Keine Fragen im Topf.');
      startGame({
        mode: pr.mode, names, startStack: Math.max(1, Number(pr.startStack) || 1000), schedule,
        levelEvery: Math.max(1, Number(pr.levelEvery) || 3), rounds: Math.max(0, Number(pr.rounds) || 0),
        timer: Math.max(0, Number(pr.timer) || 0), tts: !!pr.tts, builtin: !!pr.builtin
      });
      break;
    }
    case 'resume': S = load(LS_STATE, null); history = []; render(); break;
    case 'next': next(); break;
    case 'undo': undo(); break;
    case 'fold': act('fold'); break;
    case 'call': act('call'); break;
    case 'allin': { const p = P(S.r.toAct); act('raise', H(p).inRound + p.stack); break; }
    case 'raise': {
      const v = parseNum($('#raise-to').value);
      const p = P(S.r.toAct); const h = H(p); const r = S.r;
      const maxTo = h.inRound + p.stack;
      const minTo = Math.min(r.currentBet === 0 ? r.bb : r.currentBet + r.minRaise, maxTo);
      if (isNaN(v) || v < minTo) return toast(`Mindestens ${fmt(minTo)}.`);
      act('raise', Math.min(v, maxTo));
      break;
    }
    case 'preset': $('#raise-to').value = el.dataset.v; break;
    case 'swap': swapQuestion(); break;
    case 'timer-start': startTimer(); break;
    case 'timer-stop': stopTimer(); render(); break;
    case 'tts':
      S.settings.tts = !S.settings.tts; save(); render();
      if (!S.settings.tts) speechSynthesis?.cancel(); else speak('Sprachausgabe an.');
      break;
    case 'fullscreen':
      if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
      break;
    case 'open': modal = el.dataset.modal; render(); break;
    case 'close': case 'close-bg': modal = null; render(); break;
    case 'skip-round': {
      snap();
      if (isChips()) Object.entries(S.r.hand).forEach(([id, h]) => { byId(id).stack += h.total; });
      S.round--;
      modal = null; newRound(); break;
    }
    case 'end-game': snap(); modal = null; endGame(); break;
    case 'to-setup': modal = null; S = null; history = []; render(); break;
    case 'new-game': localStorage.removeItem(LS_STATE); S = null; history = []; render(); break;
    case 'toggle-out': { snap(); const p = byId(el.dataset.id); p.out = !p.out; if (!p.out && isChips() && p.stack <= 0) p.stack = S.settings.startStack; save(); render(); break; }
    case 'add-live-player': {
      const inp = $('#new-player'); const n = inp.value.trim(); if (!n) return;
      snap();
      S.players.push({ id: 'p' + (S.nextId++), name: n, stack: isChips() ? S.settings.startStack : 0, out: false });
      save(); render(); break;
    }
    case 'del-q': { const c = getCustom().filter((q) => q.id !== el.dataset.id); store(LS_CUSTOM, c); render(); break; }
    case 'export-q': {
      const blob = new Blob([JSON.stringify(getCustom(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const l = document.createElement('a');
      l.href = url; l.download = 'schaetzpoker-fragen.json'; l.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      break;
    }
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.prefPlayer != null) { const pr = getPrefs(); pr.players[Number(t.dataset.prefPlayer)] = t.value; store(LS_PREFS, pr); }
  else if (t.dataset.pref) {
    const pr = getPrefs(); const k = t.dataset.pref;
    pr[k] = t.type === 'checkbox' ? t.checked : (t.type === 'number' ? Number(t.value) : t.value);
    store(LS_PREFS, pr);
  } else if (t.dataset.est) { S.r.estimates[t.dataset.est] = parseNum(t.value); save(); }
  else if (t.dataset.pname) { byId(t.dataset.pname).name = t.value; save(); }
  else if (t.dataset.pstack) { const v = parseNum(t.value); if (!isNaN(v) && v >= 0) { byId(t.dataset.pstack).stack = Math.floor(v); save(); } }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.pref === 'tts' || t.dataset.pref === 'builtin' || t.dataset.pref === 'startStack') render();
  if (t.dataset.pname || t.dataset.pstack) render();
  if (t.matches('[data-import]') && t.files[0]) {
    t.files[0].text().then((txt) => {
      try {
        const arr = JSON.parse(txt); if (!Array.isArray(arr)) throw 0;
        const ok = arr.filter((q) => q && q.q && !isNaN(parseNum(q.a))).map((q, i) => ({
          id: q.id || 'c' + Date.now() + i, q: String(q.q), a: parseNum(q.a), unit: q.unit || '', h1: q.h1 || '', h2: q.h2 || '', info: q.info || ''
        }));
        const c = getCustom(); const ids = new Set(c.map((x) => x.id));
        store(LS_CUSTOM, c.concat(ok.filter((q) => !ids.has(q.id))));
        toast(`${ok.length} Fragen importiert.`); render();
      } catch { toast('Datei konnte nicht gelesen werden.'); }
    });
  }
});
document.addEventListener('submit', (e) => {
  const f = e.target; if (f.dataset.form !== 'addq') return;
  e.preventDefault();
  const d = Object.fromEntries(new FormData(f));
  const a = parseNum(d.a);
  if (isNaN(a)) return toast('Antwort muss eine Zahl sein.');
  const c = getCustom();
  c.push({ id: 'c' + Date.now(), q: d.q.trim(), a, unit: d.unit.trim(), h1: d.h1.trim(), h2: d.h2.trim(), info: d.info.trim() });
  store(LS_CUSTOM, c); toast('Frage gespeichert.'); render();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modal) { modal = null; render(); return; }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
  if (modal || !S || S.screen !== 'game') return;
  if (e.key === 'Enter' && document.activeElement?.dataset.est != null) {
    const all = [...document.querySelectorAll('[data-est]')];
    const i = all.indexOf(document.activeElement);
    if (i < all.length - 1) { all[i + 1].focus(); e.preventDefault(); return; }
    e.preventDefault(); next(); return;
  }
  if (e.key === 'Enter' && document.activeElement?.id === 'raise-to') { e.preventDefault(); $('[data-act="raise"]')?.click(); return; }
  if (typing) return;
  if ((e.key === ' ' || e.key === 'ArrowRight') && $('.primary')) { e.preventDefault(); next(); }
  if ((e.key === 'z' && (e.ctrlKey || e.metaKey)) || e.key === 'Backspace') { e.preventDefault(); undo(); }
});

if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => {};
render();
