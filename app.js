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
  startStack: 2000,
  chips: [
    { c: 'Weiß', v: 25, n: 0 }, { c: 'Rot', v: 50, n: 0 }, { c: 'Grün', v: 100, n: 0 },
    { c: 'Blau', v: 250, n: 0 }, { c: 'Schwarz', v: 500, n: 0 }
  ],
  schedule: '25/50, 50/100, 75/150, 100/200, 150/300, 200/400, 300/600, 400/800, 500/1000, 750/1500, 1000/2000',
  levelEvery: 3,
  rounds: 0,
  timer: 60,
  tts: false,
  voice: '',
  rate: 1,
  help: true,
  builtin: true
};

let S = null;          // aktueller Spielzustand
let history = [];      // Undo-Stack
let modal = null;      // offenes Modal
let rulesTab = 'ablauf';
let timer = { left: 0, int: null };

/* ---------- Icons (inline SVG, erben die Textfarbe) ---------- */
const svg = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
const ICON = {
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  players: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18.5 14.2A6.5 6.5 0 0 1 21.5 20"/>'),
  rules: svg('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>'),
  soundOn: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/>'),
  soundOff: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="m17 9 5 6"/><path d="m22 9-5 6"/>'),
  full: svg('<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>'),
  menu: svg('<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>'),
  close: svg('<path d="M6 6l12 12"/><path d="M18 6 6 18"/>')
};

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

function getPrefs() { return JSON.parse(JSON.stringify(Object.assign({}, DEFAULT_PREFS, load(LS_PREFS, {})))); }
function getCustom() { return load(LS_CUSTOM, []); }
function questionPool(builtin) {
  const custom = getCustom();
  return (builtin ? (window.BUILTIN_QUESTIONS || []) : []).concat(custom);
}

/* ---------- Sprachausgabe & Ton ---------- */
let voices = [];
function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  voices = speechSynthesis.getVoices().filter((v) => v.lang && v.lang.toLowerCase().replace('_', '-').startsWith('de'));
  voices.sort((a, b) => voiceScore(b) - voiceScore(a));
  if (modal === 'voice') render();
}
// Bewertet Stimmen: hochwertige (Premium/Enhanced/Natural/Google) nach oben, Spaßstimmen von macOS nach unten
function voiceScore(v) {
  const n = v.name.toLowerCase();
  let s = 0;
  if (/premium/.test(n)) s += 60;
  if (/natural|neural/.test(n)) s += 55;
  if (/enhanced|erweitert|verbessert/.test(n)) s += 45;
  if (/online/.test(n)) s += 20;
  if (/google/.test(n)) s += 35;
  if (/anna|petra|markus|yannick|helena|katja|conrad|amala|seraphina|florian|killian|louisa|vicki|hedda|stefan/.test(n)) s += 6;
  if (v.lang === 'de-DE') s += 3;
  if (/grandma|grandpa|oma|opa|eddy|flo|reed|rocko|sandy|shelley|albert|bad news|bahh|bells|boing|bubbles|cellos|wobble|good news|jester|organ|superstar|trinoids|whisper|zarvox|junior|ralph|kathy|fred/.test(n)) s -= 80;
  return s;
}
function bestVoice() {
  const pref = getPrefs().voice;
  return voices.find((v) => v.voiceURI === pref) || voices[0] || null;
}
function voiceLabel(v) {
  const n = v.name.toLowerCase();
  const q = voiceScore(v) >= 40 ? ' ★ hohe Qualität' : voiceScore(v) < 0 ? ' (Spaßstimme)' : '';
  return `${v.name} – ${v.lang}${q}`;
}
function speak(text, force) {
  if (!force && (!S || !S.settings.tts)) return;
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const pr = getPrefs();
  const v = bestVoice();
  // Satzweise sprechen: natürlichere Pausen und kein Abbrechen bei langen Texten (Chrome-Bug)
  const parts = String(text).split(/(?<=[.!?…:])\s+/).map((x) => x.trim()).filter(Boolean);
  parts.forEach((part) => {
    const u = new SpeechSynthesisUtterance(part);
    u.lang = v ? v.lang : 'de-DE';
    if (v) u.voice = v;
    u.rate = Number(pr.rate) || 1;
    u.pitch = 1;
    speechSynthesis.speak(u);
  });
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
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
      rounds: cfg.rounds, timer: cfg.timer, tts: cfg.tts, help: cfg.help
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
    estimates: {}, contrib: {}, potCalc: false, result: null, foldWin: null, nextLevelIn: S.settings.levelEvery - ((S.round - 1) % S.settings.levelEvery)
  };
  if (isChips()) {
    act.forEach((p) => { S.r.hand[p.id] = { inRound: 0, total: 0, folded: false, allIn: false }; });
    fxChips(P(sbIdx).id, 'pot', putChips(P(sbIdx), sb));
    fxChips(P(bbIdx).id, 'pot', putChips(P(bbIdx), bb));
    S.r.currentBet = Math.max(H(P(sbIdx)).inRound, H(P(bbIdx)).inRound);
  }
  S.screen = 'game';
  save(); renderScene();
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
  const before = p.stack;
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
  fxChips(p.id, 'pot', before - p.stack);
  afterAction(idx);
}

function finishByFold(winner) {
  const r = S.r;
  const amount = potTotal();
  winner.stack += amount;
  fxChips('pot', winner.id, amount);
  r.foldWin = { id: winner.id, amount };
  r.result = { ranking: [], pots: [{ amount, winners: [winner.id] }] };
  r.phase = 'result';
  r.toAct = -1;
  stopTimer();
  save(); render();
  speak(`${winner.name} gewinnt den Pot von ${fmt(amount)}, alle anderen haben gepasst. Die richtige Antwort war ${spokenAnswer()}.`);
}

/* ---------- Auflösung / Side-Pots ---------- */
// Reine Pot-Berechnung (Haupt- und Side-Pots).
// rows: [{ id, total, live, dist, order }] – total = gesamt eingesetzt, live = noch im Spiel, order = Sitzfolge ab Dealer
function computePots(rows) {
  const live = rows.filter((x) => x.live);
  const sum = rows.reduce((s, x) => s + x.total, 0);
  const levels = [...new Set(live.map((x) => x.total))].filter((L) => L > 0).sort((x, y) => x - y);
  const pots = []; const payout = {};
  let prev = 0; let distributed = 0;
  levels.forEach((L, li) => {
    let slice = rows.reduce((s, x) => s + Math.min(x.total, L) - Math.min(x.total, prev), 0);
    if (li === levels.length - 1) slice = sum - distributed; // Rest inkl. Einsätze von Gepassten
    const elig = live.filter((x) => x.total >= L);
    const best = Math.min(...elig.map((x) => x.dist));
    const winners = elig.filter((x) => Math.abs(x.dist - best) < 1e-9).sort((x, y) => x.order - y.order);
    const share = Math.floor(slice / winners.length);
    let rest = slice - share * winners.length;
    winners.forEach((w) => { payout[w.id] = (payout[w.id] || 0) + share + (rest > 0 ? 1 : 0); if (rest > 0) rest--; });
    if (slice > 0) pots.push({ amount: slice, winners: winners.map((w) => w.id), refund: elig.length === 1 && levels.length > 1 && li === levels.length - 1 });
    distributed += slice; prev = L;
  });
  return { pots, payout };
}

function resolveShowdown() {
  const r = S.r; const a = Number(r.q.a);
  const has = (p) => r.estimates[p.id] != null && !isNaN(r.estimates[p.id]);
  const contenders = isChips() ? S.players.filter((p) => inHand(p)) : S.players.filter(inPlay);
  const ranking = contenders.filter(has)
    .map((p) => ({ id: p.id, est: r.estimates[p.id], dist: Math.abs(r.estimates[p.id] - a) }))
    .sort((x, y) => x.dist - y.dist);
  const dist = Object.fromEntries(ranking.map((x) => [x.id, x.dist]));

  if (isChips()) {
    const missing = contenders.filter((p) => !has(p));
    if (missing.length) { toast('Bitte Schätzungen eintragen für: ' + missing.map((p) => p.name).join(', ')); return; }
  }
  let pots = [];
  let modPot = false;
  if (!isChips() && r.potCalc) {
    const c = (p) => Math.max(0, Number(r.contrib[p.id]) || 0);
    const rows = S.players.filter(inPlay).filter((p) => c(p) > 0 || has(p));
    const noBet = rows.filter((p) => has(p) && c(p) <= 0);
    if (noBet.length) { toast('Bitte Einsatz eintragen für: ' + noBet.map((p) => p.name).join(', ')); return; }
    if (!rows.some(has)) { toast('Mindestens eine Schätzung eintragen.'); return; }
    modPot = true;
    pots = computePots(rows.map((p) => ({ id: p.id, total: c(p), live: has(p), dist: dist[p.id], order: seatOrder(p) }))).pots;
  }
  snap();
  if (isChips()) {
    const res = computePots(S.players.filter((p) => r.hand[p.id]).map((p) => ({
      id: p.id, total: H(p).total, live: inHand(p), dist: dist[p.id], order: seatOrder(p)
    })));
    pots = res.pots;
    Object.entries(res.payout).forEach(([id, v]) => { byId(id).stack += v; fxChips('pot', id, v); });
  }
  r.result = { ranking, pots, modPot };
  r.phase = 'result';
  stopTimer();
  save(); render();
  let txt = `${pick(['Die richtige Antwort lautet …', 'Und die Lösung ist …', 'Richtig ist …'])} ${spokenAnswer()}!`;
  if (ranking.length) {
    const best = ranking.filter((x) => Math.abs(x.dist - ranking[0].dist) < 1e-9).map((x) => byId(x.id).name);
    txt += ` ${pick(['Am nächsten dran:', 'Die beste Schätzung hatte:', 'Am besten geschätzt hat:'])} ${best.join(' und ')}.`;
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
  save(); renderScene();
  announce();
  if (r.phase === 'question' && S.settings.timer > 0) startTimer();
}
function announce() {
  const r = S.r; if (!r) return;
  const names = (i) => (i >= 0 ? P(i).name : '');
  switch (r.phase) {
    case 'intro': {
      const open = S.round === 1
        ? pick(['Herzlich willkommen zum Schätzpoker! Wir starten mit Runde 1.', 'Willkommen am Tisch! Runde 1, es geht los.'])
        : pick([`Weiter geht's mit Runde ${S.round}.`, `Runde ${S.round}!`, `Auf in Runde ${S.round}.`]);
      const lvl = r.levelUp ? pick(['Achtung: Die Blinds steigen!', 'Es wird teurer, die Blinds steigen!']) : '';
      speak(`${open} ${lvl} ${names(S.dealer)} hat den Dealer-Button. ${names(r.sbIdx)} setzt ${fmt(r.sb)} als Small Blind, ${names(r.bbIdx)} setzt ${fmt(r.bb)} als Big Blind.`);
      break;
    }
    case 'question':
      speak(`${pick(['Aufgepasst, hier kommt die Frage:', 'Und jetzt die Frage:', 'Hört gut zu:', 'Die nächste Frage lautet:'])} ${r.q.q} ${pick(['Schreibt eure Schätzung verdeckt auf.', 'Zettel und Stift raus, und schön verdeckt aufschreiben.', 'Jeder schreibt seine Schätzung auf, ohne dass die anderen sie sehen.'])}`);
      break;
    case 'hint1': speak(`${pick(['Hier kommt der erste Hinweis:', 'Erster Hinweis:', 'Ein kleiner Tipp für euch:'])} ${r.q.h1}`); break;
    case 'hint2': speak(`${pick(['Und hier der zweite Hinweis:', 'Zweiter und letzter Hinweis:', 'Noch ein Hinweis, der letzte:'])} ${r.q.h2}`); break;
    case 'bet0': case 'bet1': case 'bet2': {
      const k = Number(r.phase.slice(3)) + 1;
      const who = isChips() ? r.toAct : firstToActModerator();
      if (isChips() && r.betDone) speak(`Setzrunde ${k} entfällt. Es kann niemand mehr setzen.`);
      else speak(`${k === 3 ? 'Letzte Setzrunde.' : `Setzrunde ${k}.`} ${names(who)}, ${pick(['du bist dran.', 'du beginnst.', 'deine Entscheidung.'])}`);
      break;
    }
    case 'showdown': speak(pick(['Showdown! Deckt eure Schätzungen auf.', 'Zettel auf den Tisch, zeigt her!', 'Und jetzt: aufdecken!'])); break;
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
  timer.total = timer.left;
  timer.int = setInterval(() => {
    timer.left--;
    const el = $('#timer'); if (el) { el.textContent = timer.left; el.classList.toggle('urgent', timer.left <= 10); }
    const dial = $('.timer-dial'); if (dial) dial.style.setProperty('--p', timer.left / (timer.total || 1));
    if (timer.left <= 5 && timer.left > 0) beep(660, 0.08);
    if (timer.left <= 0) { stopTimer(); beep(440, 0.5, 2); speak('Die Zeit ist um. Stifte weg!'); render(); }
  }, 1000);
  render();
}
function stopTimer() { if (timer.int) clearInterval(timer.int); timer.int = null; }

/* ---------- Toast ---------- */
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2800);
}

/* =========================================================
   RENDERING
   ========================================================= */
// render(): neu zeichnen, Bewegung (fx.js) misst davor und spielt danach.
// renderScene(): dasselbe als Szenenwechsel, für Phasenwechsel.
const HAS_FX = typeof FX !== 'undefined';
function render() { if (HAS_FX) FX.capture(); renderNow(); if (HAS_FX) FX.play(); }
function renderScene() { if (HAS_FX) FX.transition(render); else render(); }
const fxChips = (from, to, amount) => { if (HAS_FX && amount > 0) FX.chips(from, to, amount, S && S.r ? S.r.bb : 1); };
function renderNow() {
  const app = $('#app');
  const prevActive = document.activeElement;
  if (!S || S.screen === 'setup') app.innerHTML = renderSetup();
  else if (S.screen === 'end') app.innerHTML = renderEnd();
  else app.innerHTML = renderGame();
  const wasOpen = !!$('#modal-root').firstElementChild;
  $('#modal-root').innerHTML = modal ? renderModal() : '';
  document.body.classList.toggle('has-modal', !!modal);
  if (modal) {
    if (!wasOpen) lastFocus = focusKey(prevActive);
    if (!wasOpen || !document.activeElement || document.activeElement === document.body) $('.modal')?.focus({ preventScroll: true });
    return;
  }
  if (wasOpen && lastFocus) {
    const back = document.querySelector(lastFocus); lastFocus = null;
    if (back && !back.disabled) { back.focus({ preventScroll: true }); if (!HAS_FX) countUp(); return; }
  }
  const focus = document.querySelector('[data-autofocus]');
  if (focus) focus.focus({ preventScroll: true });
  if (!HAS_FX) countUp();
}
let lastPhaseKey = '';
let lastFocus = null; // Selektor des Buttons, der das Modal geöffnet hat
function focusKey(el) {
  if (!el || !el.dataset || !el.dataset.act) return null;
  return `#app [data-act="${el.dataset.act}"]` + (el.dataset.modal ? `[data-modal="${el.dataset.modal}"]` : '');
}
let countedKey = '';
// Einmaliger Moment pro Runde: die Lösung zählt hoch (nicht bei „weniger Bewegung“)
function countUp() {
  const el = document.querySelector('.answer b[data-count]');
  if (!el || !S || !S.r) return;
  const key = S.round + ':' + (S.r.q.id || S.r.q.q);
  if (key === countedKey) return;
  countedKey = key;
  const target = Number(el.dataset.count); const final = el.textContent;
  if (!isFinite(target) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const dec = (String(target).split('.')[1] || '').length;
  const t0 = performance.now(); const dur = 1100;
  const step = (t) => {
    if (!el.isConnected) return;
    const k = Math.min(1, (t - t0) / dur); const e = 1 - Math.pow(1 - k, 4);
    const v = target * e;
    el.textContent = k < 1 ? (el.dataset.year ? String(Math.round(v)) : fmt(Number(v.toFixed(dec)))) : final;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------- Setup ---------- */
function renderSetup() {
  const pr = getPrefs();
  const pool = questionPool(pr.builtin).length;
  const saved = load(LS_STATE, null);
  const hasSaved = saved && saved.screen === 'game';
  const resume = hasSaved ? `
    <div class="resume">
      <p><b>Ein Spiel läuft noch.</b> Runde ${saved.round}, ${saved.players.length} Spieler, ${saved.settings.mode === 'chips' ? 'digitale Chips' : 'nur Moderator'}.</p>
      <button class="btn gold" data-act="resume">Weiterspielen</button>
    </div>` : '';
  const players = pr.players.map((n, i) => `
      <div class="player-row">
        <span class="seat">${i + 1}</span>
        <input type="text" maxlength="18" placeholder="Spieler ${i + 1}" aria-label="Name Spieler ${i + 1}" value="${esc(n)}" data-pref-player="${i}">
        <button class="icon-btn" title="Entfernen" aria-label="Spieler ${i + 1} entfernen" data-act="rm-player" data-i="${i}" ${pr.players.length <= 2 ? 'disabled' : ''}>${ICON.close}</button>
      </div>`).join('');
  return `
  <header class="title-card">
    <div class="spot" aria-hidden="true"></div>
    <div class="marquee" aria-hidden="true"></div>
    <div class="tc-inner">
      <h1 class="tc-title" aria-label="Schätzpoker"><span class="w1">Schätz</span><span class="w2">poker</span></h1>
      <p class="tag">Quiz trifft Poker. Jeder schreibt eine Zahl auf, dann wird gesetzt, geblufft und aufgedeckt. Am nächsten dran gewinnt den Pot.</p>
      ${resume}
      <a class="btn ${hasSaved ? 'ghost' : 'gold'} big tc-cta" href="#einrichten">${hasSaved ? 'Neues Spiel einrichten' : 'Tisch einrichten'}</a>
    </div>
    <div class="tc-props" aria-hidden="true">
      <figure class="slip hero-slip">
        <span class="slip-q">Wie hoch ist der Eiffelturm?</span>
        <span class="slip-line"><span class="slip-est">312</span><span class="slip-unit">Meter</span></span>
      </figure>
      <i class="prop-chip c1"></i><i class="prop-chip c2"></i><i class="prop-chip c3"></i>
    </div>
  </header>
  <div class="setup" id="einrichten">
    <h2 class="setup-title">Tisch einrichten</h2>
    <section class="panel">
      <h2>Modus</h2>
      <div class="mode-pick">
        <button class="mode ${pr.mode === 'moderator' ? 'on' : ''}" aria-pressed="${pr.mode === 'moderator'}" data-act="mode" data-mode="moderator">
          <b>Nur Moderator</b><span>Ihr spielt mit echten Chips. Die Seite sagt Blinds, Fragen und Hinweise an.</span>
        </button>
        <button class="mode ${pr.mode === 'chips' ? 'on' : ''}" aria-pressed="${pr.mode === 'chips'}" data-act="mode" data-mode="chips">
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
      <label>Startchips pro Spieler
        <input type="number" min="1" step="1" value="${pr.startStack}" data-pref="startStack"></label>
      <label>Blinds steigen alle … Runden
        <input type="number" min="1" step="1" value="${pr.levelEvery}" data-pref="levelEvery"></label>
      <label class="full">Blind-Stufen (Small/Big)
        <input type="text" value="${esc(pr.schedule)}" data-pref="schedule"></label>
      <label>Anzahl Fragen <small>(0 = bis einer alles hat / offen)</small>
        <input type="number" min="0" step="1" value="${pr.rounds}" data-pref="rounds"></label>
      <label>Schreib-Timer in Sekunden <small>(0 = aus)</small>
        <input type="number" min="0" step="5" value="${pr.timer}" data-pref="timer"></label>
      <div class="check-row full"><label class="check"><input type="checkbox" ${pr.tts ? 'checked' : ''} data-pref="tts"> Sprachausgabe – die Seite moderiert laut</label>
        <button class="btn ghost sm" data-act="open" data-modal="voice">Stimme wählen</button></div>
      <label class="check"><input type="checkbox" ${pr.help !== false ? 'checked' : ''} data-pref="help"> Anfänger-Hilfe – kurze Erklärung bei jedem Schritt</label>
      <label class="check"><input type="checkbox" ${pr.builtin ? 'checked' : ''} data-pref="builtin"> Eingebaute Fragen verwenden (${(window.BUILTIN_QUESTIONS || []).length})</label>
    </section>
    <section class="panel">
      <h2>Deine Chips <small>(Farbe, Wert, Anzahl im Set – optional)</small></h2>
      <div class="chip-cfg">${pr.chips.map((x, i) => `
        <div class="chip-row">
          <span class="swatch" style="--c:${CHIP_COLORS[x.c] || '#888'}"></span>
          <select data-chip="${i}" data-field="c" aria-label="Farbe">${Object.keys(CHIP_COLORS).map((c) => `<option ${c === x.c ? 'selected' : ''}>${c}</option>`).join('')}</select>
          <label class="mini">Wert<input type="number" min="1" step="1" value="${x.v}" data-chip="${i}" data-field="v"></label>
          <label class="mini">im Set<input type="number" min="0" step="1" value="${x.n || ''}" placeholder="?" data-chip="${i}" data-field="n"></label>
        </div>`).join('')}</div>
      <div id="chip-plan">${chipTable(Number(pr.startStack) || 0, pr.players.length, pr.chips, parseSchedule(pr.schedule))}</div>
    </section>
    <section class="panel row">
      <div class="pool"><b>${pool}</b> Fragen im Topf, davon <b>${getCustom().length}</b> eigene</div>
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
  // Auftritts-Animationen nur beim ersten Zeichnen einer Phase, nicht bei jedem Neuzeichnen
  const phaseKey = S.round + ':' + r.phase; const fresh = phaseKey !== lastPhaseKey; lastPhaseKey = phaseKey;
  return `
  <div class="game ${isChips() ? 'chips' : 'mod'} phase-${r.phase.replace(/\d/, '')} ${fresh ? 'fresh' : ''}">
    <header class="bar">
      <div class="brand">Schätzpoker</div>
      <div class="board" role="group" aria-label="Spielstand"><i class="bulbs" aria-hidden="true"></i>
        <div class="stat"><small>Runde</small><b>${roundsTxt}</b></div>
        <div class="stat blinds ${r.levelUp && r.phase === 'intro' ? 'flash' : ''}"><small>Blinds, Stufe ${lvl}</small><b>${fmt(r.sb)}/${fmt(r.bb)}</b><em>${nextUp}</em></div>
        ${isChips() ? `<div class="stat pot"><small>Pot</small><b class="pot-num" data-tween="board-pot" data-value="${pot()}" data-delay="420">${fmt(pot())}</b></div>` : ''}
      </div>
      <nav aria-label="Spielsteuerung">
        <button class="icon-btn" title="Rückgängig (Strg+Z)" aria-label="Rückgängig" data-act="undo" ${history.length ? '' : 'disabled'}>${ICON.undo}</button>
        <button class="icon-btn" title="Spieler" aria-label="Spieler verwalten" data-act="open" data-modal="players">${ICON.players}</button>
        <button class="icon-btn" title="Regeln" aria-label="Spielregeln" data-act="open" data-modal="rules">${ICON.rules}</button>
        <button class="icon-btn" title="Sprachausgabe" aria-label="Sprachausgabe" aria-pressed="${!!S.settings.tts}" data-act="tts">${S.settings.tts ? ICON.soundOn : ICON.soundOff}</button>
        <button class="icon-btn hide-sm" title="Vollbild" aria-label="Vollbild" data-act="fullscreen">${ICON.full}</button>
        <button class="icon-btn" title="Menü" aria-label="Menü" data-act="open" data-modal="menu">${ICON.menu}</button>
      </nav>
    </header>
    <main>
      <section class="stage">${renderStage()}</section>
      <aside class="table">${renderTable()}</aside>
    </main>
    <footer class="steps"><ol aria-label="Ablauf der Runde">${PHASES.map((ph, i) => {
      const cur = PHASES.indexOf(r.phase);
      return `<li class="${i < cur ? 'done' : ''} ${i === cur ? 'cur' : ''}" ${i === cur ? 'aria-current="step"' : ''}>${PHASE_LABEL[ph]}</li>`;
    }).join('')}</ol></footer>
  </div>`;
}

function questionBlock(small) {
  const r = S.r; const ph = PHASES.indexOf(r.phase);
  const hints = [];
  if (ph >= PHASES.indexOf('hint1')) hints.push(['1', r.q.h1]);
  if (ph >= PHASES.indexOf('hint2')) hints.push(['2', r.q.h2]);
  return `
    <div class="qcard slip ${small ? 'small' : ''}">
      <div class="qlabel"><span>Frage ${S.round}</span>${r.q.unit ? `<span>Antwort in <b>${esc(r.q.unit)}</b></span>` : ''}</div>
      <h2 class="qtext">${esc(r.q.q)}</h2>
    </div>
    ${hints.length ? `<div class="hints">${hints.map(([n, t]) => `<div class="hint ${r.phase === 'hint' + n ? 'new' : ''}"><span class="hint-n">Hinweis ${n}</span><p>${esc(t)}</p></div>`).join('')}</div>` : ''}`;
}

function primary(label, extra = '') {
  return `<button class="btn gold big primary" data-act="next" ${extra}>${label}</button>`;
}

function renderStage() {
  return stageContent() + helpBox();
}
function stageContent() {
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
          <p class="sub">Dealer-Button: <b>${name(S.dealer)}</b>. ${isChips() ? 'Die Blinds wurden automatisch gesetzt.' : 'Bitte die Blinds in die Mitte legen.'}</p>
          ${primary('Frage stellen', 'data-autofocus')}
        </div>`;
    case 'question':
      return `
        ${questionBlock(false)}
        <p class="write-note">Jeder schreibt seine Schätzung <b>verdeckt</b> auf.</p>
        <div class="tools">
          ${timer.int ? `<div class="timer-wrap"><span class="timer-dial" style="--p:${timer.left / (timer.total || timer.left || 1)}" aria-hidden="true"></span><span id="timer" class="timer ${timer.left <= 10 ? 'urgent' : ''}" role="timer" aria-label="Sekunden übrig">${timer.left}</span><button class="btn ghost sm" data-act="timer-stop">Stopp</button></div>`
            : `<button class="btn ghost" data-act="timer-start">Timer starten (${S.settings.timer || 60} s)</button>`}
          <button class="btn ghost" data-act="swap">Andere Frage</button>
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


function helpBox() {
  if (!S.settings.help) return '';
  const r = S.r; const ph = r.phase;
  const T = {
    intro: 'Die zwei Spieler links vom Dealer zahlen Pflichteinsätze, die <b>Blinds</b>. So liegt in jeder Runde schon etwas im Pot und es lohnt sich zu spielen. Der Dealer-Button wandert jede Runde eins weiter.',
    question: 'Jeder schreibt <b>eine Zahl</b> auf einen Zettel und legt ihn verdeckt vor sich. Danach wird nichts mehr geändert! Gesetzt wird erst gleich.',
    bet0: 'Reihum entscheidet jeder: <b>Passen</b> (raus, Einsatz ist weg), <b>Mitgehen</b> (auf den höchsten Einsatz auffüllen), <b>Erhöhen</b> (mehr setzen) oder <b>All-in</b>. Wer den Big Blind schon bezahlt hat, darf am Ende <b>checken</b>. Die Runde endet, wenn alle gleich viel drin haben.',
    bet: '<b>Checken</b> = nichts setzen (nur, wenn noch keiner gesetzt hat). <b>Setzen</b> = erster Einsatz der Runde, mindestens 1 Big Blind. Danach: passen, mitgehen oder erhöhen. Die Runde endet, wenn alle gleich viel gesetzt oder gepasst haben.',
    hint: 'Der Hinweis zeigt dir, ob deine Zahl gut oder daneben ist. Deine Schätzung bleibt trotzdem stehen – jetzt geht es ums Pokern: weitermachen, aussteigen oder bluffen?',
    showdown: 'Alle, die nicht gepasst haben, zeigen ihren Zettel. Wer gepasst hat, muss seinen Zettel nicht zeigen.',
    result: 'Wer am nächsten an der richtigen Antwort liegt, gewinnt den Pot – egal ob drüber oder drunter. Gleich nah = Pot wird geteilt. Wer All-in war, kann nur so viel gewinnen, wie er selbst eingesetzt hat (Side-Pot).'
  };
  const key = ph === 'bet0' ? 'bet0' : ph.startsWith('bet') ? 'bet' : ph.startsWith('hint') ? 'hint' : ph;
  if (!T[key]) return '';
  return `<div class="help"><p><b class="help-k">Kurz erklärt:</b> ${T[key]}</p><button class="link" data-act="rules-at" data-tab="${key === 'result' || key === 'showdown' ? 'sidepot' : key.startsWith('bet') ? 'zuege' : 'poker'}">Mehr dazu in den Regeln</button></div>`;
}

function renderBetting() {
  const r = S.r; const k = Number(r.phase.slice(3)) + 1;
  const nextLabel = k === 3 ? 'Zum Showdown' : `Hinweis ${k} aufdecken`;
  if (!isChips()) {
    const first = firstToActModerator();
    return `
      <div class="betbox">
        <div class="bet-title">Setzrunde ${k} <small>von 3</small></div>
        <p class="sub">Es beginnt <b>${esc(P(first).name)}</b>${k === 1 ? ' (links vom Big Blind)' : ' (links vom Dealer)'}, dann reihum im Uhrzeigersinn.</p>
        <p class="sub small">Einsätze bleiben <b>vor euch</b> liegen. Wenn alle gleich viel gesetzt oder gepasst haben, schiebt <b>${esc(P(S.dealer).name)}</b> (Dealer) alles in die Mitte.</p>
        ${primary(`Setzrunde beendet, ${nextLabel.charAt(0).toLowerCase() + nextLabel.slice(1)}`, 'data-autofocus')}
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
        <dl class="actor-meta"><div><dt>Stack</dt><dd>${fmt(p.stack)}</dd></div><div><dt>Gesetzt</dt><dd>${fmt(h.inRound)}</dd></div>${toCall > 0 ? `<div class="due"><dt>Zu zahlen</dt><dd>${fmt(toCall)}</dd></div>` : ''}</dl>
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
  r.contrib = r.contrib || {};
  const list = isChips() ? S.players.filter((p) => inHand(p)) : S.players.filter(inPlay);
  const val = (v) => (v == null || isNaN(v) ? '' : String(v).replace('.', ','));
  const calc = !isChips() && r.potCalc;
  return `
    ${questionBlock(true)}
    <div class="showdown">
      <div class="bet-title">Showdown: Schätzungen aufdecken</div>
      <p class="sub">${isChips()
        ? 'Tragt die Schätzungen aller Spieler ein, die noch dabei sind.'
        : 'Schätzungen eintragen, dann zeigt die Seite, wer am nächsten dran war. <b>Wer gepasst hat: Feld leer lassen.</b>'}</p>
      ${!isChips() ? `
        <button class="btn ${calc ? 'gold' : 'ghost'} sm potcalc-toggle" data-act="potcalc">${calc ? '✓ Pot-Rechner an' : 'Jemand ist All-in? Pot-Rechner einschalten'}</button>
        ${calc ? '<p class="sub small">Tragt bei <b>jedem</b>, der in dieser Runde Chips in den Pot gelegt hat, ein, wie viel es <b>insgesamt</b> war (inkl. Blinds) – auch bei denen, die gepasst haben. Die Seite rechnet Haupt- und Side-Pots aus.</p>' : ''}` : ''}
      <div class="est-list ${calc ? 'with-bet' : ''}">
        ${list.map((p, i) => `
          <div class="est">
            <span class="en">${esc(p.name)}</span>
            <label class="ef"><input type="text" inputmode="decimal" placeholder="Schätzung" value="${val(r.estimates[p.id])}" data-est="${p.id}" aria-label="Schätzung von ${esc(p.name)}" ${i === 0 ? 'data-autofocus' : ''}>
              ${r.q.unit ? `<em>${esc(r.q.unit)}</em>` : ''}</label>
            ${calc ? `<label class="ef bet-in"><input type="text" inputmode="numeric" placeholder="Einsatz gesamt" value="${val(r.contrib[p.id])}" data-contrib="${p.id}" aria-label="Einsatz gesamt von ${esc(p.name)}"><em>Chips</em></label>` : ''}
          </div>`).join('')}
      </div>
      ${primary('Lösung aufdecken')}
    </div>`;
}

function potsHtml(res) {
  return `<div class="payouts">${res.pots.map((pt, i) => `
    <div><small>${res.pots.length > 1 ? (pt.refund ? 'Rückgabe (nicht gecallt)' : i === 0 ? 'Hauptpot' : `Side-Pot ${i}`) : 'Pot'}</small>
    <b>${fmt(pt.amount)}</b> an ${pt.winners.map((id) => esc(byId(id).name)).join(' &amp; ')}${pt.winners.length > 1 ? ' <em>(geteilt)</em>' : ''}</div>`).join('')}</div>`;
}

function renderResult() {
  const r = S.r; const q = r.q; const res = r.result || { ranking: [], pots: [] };
  const rank = res.ranking;
  const bestDist = rank.length ? rank[0].dist : null;
  // Letzte Runde: Fragenlimit erreicht – oder im Chip-Modus hat nur noch einer Chips
  const lastRound = (S.settings.rounds && S.round >= S.settings.rounds) ||
    (isChips() && S.players.filter((p) => !p.out && p.stack > 0).length < 2);
  const bestNames = rank.filter((x) => Math.abs(x.dist - bestDist) < 1e-9).map((x) => esc(byId(x.id).name));
  const dealer = esc(P(S.dealer).name);
  let modLine = '';
  if (!isChips()) {
    if (res.modPot) modLine = `${potsHtml(res)}<p class="sub"><b>${dealer}</b> (Dealer) teilt den Pot so auf.</p>`;
    else if (rank.length) modLine = `<p class="sub">Der Pot geht an <b>${bestNames.join(' &amp; ')}</b>${bestNames.length > 1 ? ' – wird geteilt' : ''}. <b>${dealer}</b> (Dealer) schiebt ihn rüber.<br><small>War jemand All-in? Dann mit ↶ zurück und den Pot-Rechner nutzen.</small></p>`;
  }
  return `
    <div class="result" data-key="${S.round}:${esc(q.id || '')}">
      <div class="answer-card">
        <div class="face back" aria-hidden="true"><span>?</span></div>
        <div class="face answer slip">
          <p class="qtext sm">${esc(q.q)}</p>
          <small>Die richtige Antwort</small>
          <b data-count="${Number(q.a)}" data-year="${fmtYear(q, Number(q.a)) !== fmt(Number(q.a)) ? 1 : ''}">${fmtYear(q, Number(q.a))}</b>
          <span>${esc(q.unit || '')}</span>
        </div>
      </div>
      ${q.info ? `<p class="info">${esc(q.info)}</p>` : ''}
      ${r.foldWin ? `<div class="foldwin"><b>${esc(byId(r.foldWin.id).name)}</b> gewinnt <b>${fmt(r.foldWin.amount)}</b> – alle anderen haben gepasst.</div>` : ''}
      ${rank.length ? `<ol class="ranking">${rank.map((x, i) => `
          <li class="${Math.abs(x.dist - bestDist) < 1e-9 ? 'best' : ''}" style="--i:${i}">
            <span class="n">${esc(byId(x.id).name)}</span>
            <span class="e">${fmtYear(q, x.est)}</span>
            <span class="d">${x.dist === 0 ? 'exakt!' : '± ' + fmt(x.dist)}</span>
          </li>`).join('')}</ol>` : ''}
      ${isChips() && !r.foldWin && res.pots.length ? potsHtml(res) : ''}
      ${modLine}
      <div class="after">${primary(lastRound ? 'Zur Endwertung' : 'Nächste Runde', 'data-autofocus')}</div>
    </div>`;
}

function renderTable() {
  const r = S.r; const n = S.players.length;
  // Plätze im Uhrzeigersinn um einen ovalen Tisch, Platz 1 oben
  const at = (i, kx, ky = kx, off = 0) => {
    const a = (-90 + (i * 360) / n + off) * Math.PI / 180;
    return `--x:${(50 + 50 * kx * Math.cos(a)).toFixed(2)}%;--y:${(50 + 50 * ky * Math.sin(a)).toFixed(2)}%`;
  };
  const rows = S.players.map((p, i) => {
    const h = r.hand[p.id];
    const marks = [i === r.sbIdx ? '<i class="m sb" title="Small Blind">SB</i>' : '', i === r.bbIdx ? '<i class="m bb" title="Big Blind">BB</i>' : ''].join('');
    let status = '';
    if (p.out) status = 'raus';
    else if (h && h.folded) status = 'gepasst';
    else if (h && h.allIn) status = 'all-in';
    const turn = isChips() && r.toAct === i && r.phase.startsWith('bet') && !r.betDone;
    const bet = isChips() && h && h.inRound && !r.result ? h.inRound : 0;
    return `
      <li class="seat-spot ${p.out ? 'out' : ''} ${h && h.folded ? 'folded' : ''} ${turn ? 'turn' : ''}" style="${at(i, 1)}" data-pid="${p.id}" ${turn ? 'aria-current="true"' : ''}>
        <span class="seat-anchor" aria-hidden="true"></span>
        <div class="pn"><span class="nm">${esc(p.name)}</span>${marks}</div>
        ${isChips() && !p.out ? `<div class="pv"><span class="stack" data-tween="stack-${p.id}" data-value="${p.stack}" data-delay="${r.result ? 2600 : 0}">${fmt(p.stack)}</span></div>` : ''}
        ${status ? `<div class="st">${status}</div>` : ''}
        ${i === S.dealer ? '<span class="sr">Dealer</span>' : ''}
      </li>
      ${bet ? `<li class="bet-spot" style="${at(i, .5, .7)}" aria-hidden="true"><i class="mini-chip"></i>${fmt(bet)}</li>` : ''}`;
  }).join('');
  const potNow = pot();
  const pile = Math.min(12, potNow > 0 ? 2 + Math.ceil(Math.log2(potNow / Math.max(1, r.bb) + 1) * 1.6) : 0);
  const center = isChips()
    ? `<div class="felt-center">
        <div class="pot-pile" aria-hidden="true">${Array.from({ length: pile }, (_, k) => `<i style="--k:${k};--c:${['#e0443e', '#4f7be8', '#f3ead7', '#1f8a5b', '#141016'][(k * 3) % 5]};--dx:${((k * 37) % 7) - 3}px"></i>`).join('')}</div>
        <small>Pot</small><b data-tween="felt-pot" data-value="${potNow}" data-delay="420">${fmt(potNow)}</b>
        ${r.currentBet && !r.result ? `<span>Einsatz ${fmt(r.currentBet)}</span>` : '<span>&nbsp;</span>'}
      </div>`
    : `<div class="felt-center mod"><small>Sitzordnung</small><span>im Uhrzeigersinn</span></div>`;
  const turnIdx = isChips() && r.phase.startsWith('bet') && !r.betDone ? r.toAct : -1;
  return `
    <h3 class="sr">${isChips() ? 'Tisch' : 'Sitzordnung'}</h3>
    <div class="felt ${n > 6 ? 'many' : ''}">
      ${center}
      ${turnIdx >= 0 ? `<i class="turn-ring" data-flip="turn" style="${at(turnIdx, 1)}" aria-hidden="true"></i>` : ''}
      <i class="puck" data-flip="dealer" style="${at(S.dealer, .7, .78, 360 / n / 4)}" title="Dealer-Button" aria-hidden="true">D</i>
      <ul class="seats">${rows}</ul>
    </div>`;
}

/* ---------- Endbildschirm ---------- */
function renderEnd() {
  const list = S.players.slice().sort((a, b) => b.stack - a.stack);
  return `
    <div class="end">
      <h1>Spielende</h1>
      ${isChips() ? `
        <div class="winner">${esc(list[0].name)}</div>
        <p class="sub">gewinnt mit <b>${fmt(list[0].stack)}</b> Chips</p>
        <ol class="ranking final">${list.map((p) => `<li><span class="n">${esc(p.name)}</span><span class="e">${fmt(p.stack)}</span></li>`).join('')}</ol>`
        : `<p class="sub">${S.round} ${S.round === 1 ? 'Runde' : 'Runden'} gespielt. Zählt eure Chips – wer hat am meisten?</p>`}
      <div class="row-btns center">
        <button class="btn ghost" data-act="undo" ${history.length ? '' : 'disabled'}>Letzten Schritt zurück</button>
        <button class="btn gold big" data-act="new-game">Neues Spiel</button>
      </div>
    </div>`;
}

/* ---------- Modals ---------- */
function renderModal() {
  let body = '';
  if (modal === 'rules') body = renderRules();
  else if (modal === 'voice') body = renderVoiceModal();
  else if (modal === 'menu') body = `
    <h2>Menü</h2>
    <div class="menu-list">
      <button class="btn ghost" data-act="open" data-modal="voice">Stimme &amp; Tempo</button>
      <button class="btn ghost" data-act="help-toggle">Anfänger-Hilfe: ${S && S.settings.help ? 'an' : 'aus'}</button>
      <button class="btn ghost" data-act="skip-round">Runde abbrechen &amp; neue Frage</button>
      <button class="btn ghost" data-act="end-game">Spiel jetzt beenden</button>
      <button class="btn red" data-act="to-setup">Zurück zum Start (Spiel bleibt gespeichert)</button>
    </div>
    <p class="sub small">Hinweis: „Runde abbrechen“ gibt im Chip-Modus alle Einsätze dieser Runde zurück.</p>`;
  else if (modal === 'players') body = renderPlayersModal();
  else if (modal === 'questions') body = renderQuestionsModal();
  return `<div class="modal-bg" data-act="close-bg"><div class="modal modal-${esc(modal)}" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">
    <button class="icon-btn close" data-act="close" aria-label="Schließen">${ICON.close}</button>${body.replace('<h2>', '<h2 id="modal-title">')}</div></div>`;
}

const RULE_TABS = [
  ['ablauf', 'So läuft’s'], ['poker', 'Poker-Basics'], ['zuege', 'Spielzüge'],
  ['sidepot', 'All-in & Side-Pots'], ['tisch', 'Ohne Croupier'], ['chips', 'Chips aufteilen']
];
function renderRules() {
  const n = S ? S.players.filter(inPlay).length : getPrefs().players.length;
  const stack = S ? S.settings.startStack : getPrefs().startStack;
  const R = {
    ablauf: `
      <p class="lead">Schätzpoker ist Poker – nur ohne Karten. Statt eines guten Blatts hast du eine <b>Schätzung</b>. Wer am Ende am nächsten an der richtigen Antwort liegt, gewinnt den Pot. Man muss die Antwort also nicht wissen: Man kann auch bluffen und die anderen zum Aussteigen bringen.</p>
      <ol class="rules">
        <li><b>Blinds:</b> Der Dealer-Button wandert eins weiter. Die zwei Spieler links davon zahlen Small und Big Blind.</li>
        <li><b>Frage:</b> Die Seite stellt eine Schätzfrage. Jeder schreibt <b>eine Zahl</b> verdeckt auf. Danach wird nichts mehr geändert.</li>
        <li><b>Setzrunde 1:</b> Beginnt links vom Big Blind.</li>
        <li><b>Hinweis 1</b> → <b>Setzrunde 2</b> (beginnt links vom Dealer).</li>
        <li><b>Hinweis 2</b> → <b>Setzrunde 3</b>.</li>
        <li><b>Showdown:</b> Alle, die noch dabei sind, decken auf. Dann kommt die Lösung.</li>
        <li><b>Gewinner:</b> Wer am nächsten dran ist – egal ob drüber oder drunter. Gleich nah = Pot wird geteilt.</li>
        <li>Passen alle anderen, gewinnt der Letzte sofort, ohne seinen Zettel zu zeigen.</li>
        <li>Wer keine Chips mehr hat, ist raus. Sieger ist, wer am Ende alle Chips hat (oder nach der letzten Frage die meisten).</li>
      </ol>`,
    poker: `
      <h3>Ziel</h3><p>Chips gewinnen. Alles, was in einer Runde gesetzt wird, landet im <b>Pot</b> (der Topf in der Mitte). Der Pot geht an den Gewinner der Runde.</p>
      <h3>Dealer-Button</h3><p>Ein Spieler hat den „Dealer“-Knopf. Er rückt jede Runde einen Platz im Uhrzeigersinn weiter. Er bestimmt, wer die Blinds zahlt und wer anfängt. Die Seite zeigt ihn mit <i class="m d">D</i> an.</p>
      <h3>Blinds</h3><p>Pflichteinsätze, bevor überhaupt jemand etwas weiß. Der Spieler links vom Dealer zahlt den <b>Small Blind</b> (<i class="m sb">SB</i>), der nächste den <b>Big Blind</b> (<i class="m bb">BB</i>, doppelt so viel). Ohne Blinds könnte jeder immer passen, bis er die Antwort sicher weiß. Die Blinds steigen mit der Zeit, damit das Spiel ein Ende findet.</p>
      <p>Bei nur noch <b>2 Spielern</b> zahlt der Dealer den Small Blind.</p>
      <h3>Reihenfolge</h3><p>Es geht immer im Uhrzeigersinn. In <b>Setzrunde 1</b> beginnt der Spieler links vom Big Blind (die Blinds haben ja schon „gesetzt“). In <b>Setzrunde 2 und 3</b> beginnt der erste Spieler links vom Dealer, der noch dabei ist.</p>
      <h3>Wann endet eine Setzrunde?</h3><p>Wenn jeder, der noch dabei ist, <b>gleich viel</b> gesetzt hat (oder All-in ist) und jeder mindestens einmal dran war. Erhöht jemand, sind alle anderen nochmal dran.</p>`,
    zuege: `
      <div class="moves">
        <div><b>Checken</b><p>Nichts setzen und weitergeben. Geht nur, wenn in dieser Setzrunde noch niemand gesetzt hat (bzw. als Big Blind, wenn alle nur mitgegangen sind).</p></div>
        <div><b>Setzen (Bet)</b><p>Den ersten Einsatz einer Setzrunde machen. Mindestens 1 Big Blind.</p></div>
        <div><b>Mitgehen (Call)</b><p>So viel nachlegen, dass du genauso viel drin hast wie der höchste Einsatz.</p></div>
        <div><b>Erhöhen (Raise)</b><p>Mehr setzen als der aktuelle Einsatz. Die Erhöhung muss mindestens so groß sein wie die letzte Erhöhung (am Anfang: 1 Big Blind). Beispiel: Einsatz 100 → mindestens auf 200 erhöhen. Jemand erhöht von 100 auf 300 → nächste Erhöhung mindestens auf 500.</p></div>
        <div><b>Passen (Fold)</b><p>Aussteigen. Was du in dieser Runde schon gesetzt hast, bleibt im Pot. Dein Zettel zählt nicht mehr.</p></div>
        <div><b>All-in</b><p>Alle deine Chips setzen. Du bleibst bis zum Ende im Spiel, kannst aber nur so viel gewinnen, wie du selbst eingesetzt hast (siehe Side-Pots).</p></div>
      </div>
      <h3>Tischregeln</h3>
      <ul class="rules">
        <li><b>Ansage gilt:</b> Wer laut „Mitgehen“ oder „Erhöhe auf 300“ sagt, muss es auch machen.</li>
        <li><b>Ein Zug, ein Mal:</b> Chips auf einmal hinlegen. Erst 100 hinlegen und dann nochmal 200 nachschieben zählt nur als Mitgehen (kein „Nachlegen“).</li>
        <li><b>Nicht vordrängeln:</b> Erst handeln, wenn du dran bist.</li>
        <li><b>Zettel bleibt Zettel:</b> Nach dem Aufschreiben keine Änderung. Unleserlich oder zwei Zahlen = ungültig, der Spieler muss passen.</li>
        <li><b>No-Limit:</b> Man darf jederzeit bis zu allen eigenen Chips setzen. Mehr als man vor sich hat, geht nicht (kein Geld nachkaufen während der Runde).</li>
      </ul>`,
    sidepot: `
      <p>Wenn jemand <b>All-in</b> ist, aber andere mehr setzen, wird der Pot aufgeteilt. Grund: Du kannst von jedem Gegner nur so viel gewinnen, wie du selbst eingesetzt hast.</p>
      <h3>Beispiel</h3>
      <table class="ex"><thead><tr><th>Spieler</th><th>Eingesetzt</th></tr></thead><tbody>
        <tr><td>Anna (All-in)</td><td>300</td></tr><tr><td>Ben (All-in)</td><td>600</td></tr><tr><td>Chris</td><td>1.000</td></tr></tbody></table>
      <ol class="rules">
        <li><b>Hauptpot:</b> 300 von jedem = <b>900</b>. Darum spielen alle drei.</li>
        <li><b>Side-Pot:</b> von Ben und Chris je 300 mehr = <b>600</b>. Darum spielen nur Ben und Chris.</li>
        <li><b>Rest:</b> Chris’ übrige 400 hat niemand mitgegangen → bekommt Chris zurück.</li>
      </ol>
      <p>Hat Anna die beste Schätzung, bekommt sie die 900. Den Side-Pot (600) bekommt, wer von Ben und Chris näher dran ist.</p>
      <p>Chips von Spielern, die <b>gepasst</b> haben, bleiben trotzdem im jeweiligen Pot.</p>
      <h3>Ihr müsst das nicht selbst rechnen</h3>
      <p>Im <b>Chip-Modus</b> macht die Seite das automatisch. Im <b>Moderator-Modus</b> gibt es beim Aufdecken den <b>Pot-Rechner</b>: Einsatz pro Spieler eintragen, fertig.</p>`,
    tisch: `
      <p>Ohne Croupier braucht der Pot einen festen Verantwortlichen. So klappt’s ohne Streit:</p>
      <ol class="rules">
        <li><b>Der Dealer ist Pot-Verwalter.</b> Wer den Dealer-Button hat, kümmert sich in dieser Runde um den Pot. Er wechselt jede Runde – so ist keiner dauernd dran und jeder schaut mal.</li>
        <li><b>Einsätze bleiben vor dir liegen,</b> bis die Setzrunde vorbei ist. So sieht jeder, wer wie viel gesetzt hat. Erst wenn alle gleich viel haben, schiebt der Dealer alles in die Mitte.</li>
        <li><b>Laut ansagen:</b> „Ich gehe mit“, „Ich erhöhe auf 400“, „All-in“. Bei All-in zählt der Dealer die Chips laut nach.</li>
        <li><b>All-in? Einsätze getrennt halten.</b> Am einfachsten: Der All-in-Spieler lässt seine Chips vor sich liegen, alles darüber hinaus kommt auf einen zweiten Haufen (Side-Pot). Oder ihr merkt euch die Gesamteinsätze und nutzt den Pot-Rechner.</li>
        <li><b>Auszahlen:</b> Die Seite zeigt den Gewinner, der Dealer schiebt ihm den Pot. Bei Teilung: gleichmäßig aufteilen; ein übrig bleibender Chip geht an den ersten Gewinner links vom Dealer.</li>
        <li><b>Wechselgeld:</b> Der Dealer wechselt große in kleine Chips aus dem Pot oder einer kleinen „Bank“ am Rand.</li>
        <li><b>Bei Streit</b> entscheidet die Mehrheit am Tisch – oder ihr nutzt den Chip-Modus, dann zählt die Seite mit.</li>
      </ol>`,
    chips: `
      <p>Startchips pro Spieler: <b>${fmt(stack)}</b>. So wird aufgeteilt – viele kleine Chips zum Setzen, wenige große:</p>
      ${chipTable(stack, n, getPrefs().chips, S ? S.settings.schedule : parseSchedule(getPrefs().schedule))}
      <p class="sub small">Farben und Werte stellst du auf der Startseite unter „Deine Chips“ ein. Tipp: Schreibt die Werte auf einen Zettel in die Mitte.</p>
      <h3>Wenn die Blinds hoch werden</h3>
      <p>Die kleinsten Chips braucht ihr irgendwann nicht mehr. Dann <b>hochtauschen</b>: z. B. vier 25er gegen einen 100er.</p>`
  };
  return `
    <h2>Spielregeln</h2>
    <div class="tabs">${RULE_TABS.map(([k, l]) => `<button class="tab ${k === rulesTab ? 'on' : ''}" aria-pressed="${k === rulesTab}" data-act="rules-tab" data-tab="${k}">${l}</button>`).join('')}</div>
    <div class="rules-body">${R[rulesTab] || R.ablauf}</div>`;
}
const CHIP_COLORS = {
  'Weiß': '#f2efe6', 'Rot': '#d1495b', 'Grün': '#2a9d8f', 'Blau': '#3d6fd8', 'Schwarz': '#1c1c1c',
  'Gelb': '#e9c46a', 'Orange': '#f08a3c', 'Lila': '#8e5bd0', 'Pink': '#e86aa6', 'Grau': '#8a8f98', 'Braun': '#8b5a2b', 'Hellblau': '#7cc4f0'
};
// Verteilt den Startstack auf ALLE Chip-Werte: viele kleine, wenige große.
function chipPlan(stack, chips, players) {
  const list = chips.filter((x) => x.v > 0).map((x) => ({ ...x, per: 0 })).sort((a, b) => a.v - b.v);
  const k = list.length;
  if (!k || !stack) return { list, rest: stack, ok: false };
  const wsum = list.reduce((s, _, i) => s + i + 2, 0);
  list.forEach((x, i) => {
    x.cap = x.n > 0 ? Math.floor(x.n / Math.max(1, players)) : Infinity;
    x.per = Math.min(x.cap, Math.floor(((i + 2) / wsum) * stack / x.v));
  });
  let rest = stack - list.reduce((s, x) => s + x.per * x.v, 0);
  // Rest auffüllen, große Werte zuerst
  for (let i = k - 1; i >= 0; i--) {
    const x = list[i]; const add = Math.max(0, Math.min(Math.floor(rest / x.v), x.cap - x.per));
    x.per += add; rest -= add * x.v;
  }
  return { list, rest, ok: rest === 0 };
}
function chipTable(stack, n, chips, schedule) {
  chips = chips || getPrefs().chips;
  n = Math.max(1, n || 1);
  const plan = chipPlan(stack, chips, n);
  if (!plan.list.length) return '<p class="sub small">Trage oben die Werte deiner Chips ein.</p>';
  const unused = plan.list.filter((x) => x.per === 0);
  const short = plan.list.filter((x) => x.n > 0 && x.per * n > x.n);
  let suggest = 0;
  if (unused.length) {
    for (let s = Math.ceil((stack + 1) / 500) * 500; s <= 50000; s += 500) {
      const p = chipPlan(s, chips, n);
      if (p.ok && p.list.every((x) => x.per > 0)) { suggest = s; break; }
    }
  }
  const smallest = plan.list[0].v;
  const sb = schedule && schedule[0] ? schedule[0][0] : null;
  const total = plan.list.reduce((s, x) => s + x.per * x.v, 0);
  return `<table class="ex chips-t"><thead><tr><th>Farbe</th><th>Wert</th><th>pro Spieler</th><th>für ${n} Spieler</th></tr></thead><tbody>
    ${plan.list.map((x) => `<tr class="${x.per === 0 ? 'zero' : ''}"><td><span class="swatch sm" style="--c:${CHIP_COLORS[x.c] || '#888'}"></span>${esc(x.c)}</td><td>${fmt(x.v)}</td><td>${x.per} Stück</td><td>${x.per * n}${x.n > 0 ? ` <small>von ${x.n}</small>` : ''}</td></tr>`).join('')}
    <tr class="sum"><td>Summe</td><td></td><td>${fmt(total)}</td><td>${fmt(total * n)}</td></tr></tbody></table>
    ${!plan.ok ? `<p class="warn">${fmt(stack)} lässt sich mit diesen Chips nicht genau legen${plan.rest ? ` (es fehlen ${fmt(plan.rest)})` : ''}. Startchips auf ein Vielfaches von ${fmt(smallest)} setzen${plan.list.some((x) => x.n > 0) ? ' oder es sind zu wenig Chips im Set' : ''}.</p>` : ''}
    ${unused.length ? `<p class="warn">${unused.map((x) => `${esc(x.c)} (${fmt(x.v)})`).join(', ')} ${unused.length > 1 ? 'werden' : 'wird'} bei ${fmt(stack)} Startchips nicht gebraucht${suggest ? ` – mit <b>${fmt(suggest)}</b> Startchips sind alle ${plan.list.length} Farben dabei` : ''}. Große Chips kommen sonst erst beim Hochtauschen ins Spiel.</p>` : ''}
    ${short.length ? `<p class="warn">Nicht genug Chips im Set: ${short.map((x) => esc(x.c)).join(', ')}.</p>` : ''}
    ${sb && sb % smallest !== 0 ? `<p class="warn">Der erste Small Blind (${fmt(sb)}) lässt sich mit dem kleinsten Chip (${fmt(smallest)}) nicht legen – Blind-Stufen anpassen.</p>` : ''}`;
}
function renderVoiceModal() {
  const pr = getPrefs();
  const cur = bestVoice();
  const supported = 'speechSynthesis' in window;
  return `
    <h2>Stimme &amp; Tempo</h2>
    ${!supported ? '<p class="sub">Dieser Browser unterstützt keine Sprachausgabe.</p>' : `
    <label>Stimme
      <select data-voice>${voices.length ? voices.map((v) => `<option value="${esc(v.voiceURI)}" ${cur && v.voiceURI === cur.voiceURI ? 'selected' : ''}>${esc(voiceLabel(v))}</option>`).join('') : '<option>Keine deutsche Stimme gefunden</option>'}</select></label>
    <label>Tempo: ${fmt(Number(pr.rate) || 1)}×
      <input type="range" min="0.7" max="1.4" step="0.05" value="${Number(pr.rate) || 1}" data-rate></label>
    <button class="btn gold" data-act="voice-test">Probe hören</button>
    <div class="voice-help">
      <h3>So wird die Stimme viel besser</h3>
      <p>Die Seite nutzt die Stimmen, die auf dem Gerät installiert sind. Standardmäßig sind die oft blechern – die guten muss man einmal laden:</p>
      <ul class="rules">
        <li><b>Mac:</b> Systemeinstellungen → Bedienungshilfen → Gesprochene Inhalte → Systemstimme → „Stimmen verwalten …“ → Deutsch → z. B. <b>Anna</b> oder <b>Petra</b> in der Version <b>„Premium“</b> bzw. <b>„Erweitert“</b> laden. Danach die Seite neu laden.</li>
        <li><b>Microsoft Edge</b> (Windows &amp; Mac): bringt sehr natürliche Online-Stimmen mit, z. B. <b>„Katja Online (Natural)“</b> oder <b>„Conrad Online (Natural)“</b> – meist die beste Wahl.</li>
        <li><b>Chrome:</b> „Google Deutsch“ ist okay.</li>
        <li><b>iPhone/iPad:</b> Einstellungen → Bedienungshilfen → Gesprochene Inhalte → Stimmen → Deutsch → Premium-Stimme laden.</li>
      </ul>
      <p class="sub small">Stimmen mit ★ sind hochwertig und werden automatisch bevorzugt.</p>
    </div>`}`;
}

function renderPlayersModal() {
  const rows = S.players.map((p) => `
    <div class="pm-row ${p.out ? 'out' : ''}">
      <input type="text" value="${esc(p.name)}" data-pname="${p.id}" aria-label="Name" maxlength="18">
      ${isChips() ? `<input type="number" value="${p.stack}" min="0" step="1" data-pstack="${p.id}" title="Stack (Chips vor dieser Runde nicht eingerechnet)">` : ''}
      <button class="btn sm ${p.out ? 'green' : 'ghost'}" data-act="toggle-out" data-id="${p.id}">${p.out ? 'Wieder rein' : 'Ausscheiden'}</button>
    </div>`).join('');
  return `
    <h2>Spieler</h2>
    <p class="sub small">Änderungen an Stacks gelten sofort. Ausgeschiedene / neue Spieler werden ab der nächsten Runde berücksichtigt.</p>
    <div class="pm">${rows}</div>
    <div class="row-btns">
      <input type="text" id="new-player" placeholder="Neuer Spieler" aria-label="Name neuer Spieler" maxlength="18">
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
      <button class="icon-btn" data-act="del-q" data-id="${esc(q.id)}" aria-label="Frage löschen">${ICON.close}</button></div>`).join('') : '<p class="sub small">Noch keine eigenen Fragen.</p>'}</div>
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
        timer: Math.max(0, Number(pr.timer) || 0), tts: !!pr.tts, help: pr.help !== false, builtin: !!pr.builtin
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
    case 'help-toggle': S.settings.help = !S.settings.help; save(); render(); break;
    case 'rules-at': rulesTab = el.dataset.tab; modal = 'rules'; render(); break;
    case 'rules-tab': rulesTab = el.dataset.tab; render(); document.querySelector('.modal')?.scrollTo(0, 0); break;
    case 'voice-test': speak('Hallo und herzlich willkommen zum Schätzpoker! Die Blinds betragen fünfundzwanzig und fünfzig. Viel Glück!', true); break;
    case 'potcalc': S.r.potCalc = !S.r.potCalc; save(); render(); break;
    case 'timer-start': startTimer(); break;
    case 'timer-stop': stopTimer(); render(); break;
    case 'tts':
      S.settings.tts = !S.settings.tts; save(); render();
      if (!S.settings.tts) window.speechSynthesis?.cancel(); else speak('Sprachausgabe an.');
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
  if (t.dataset.chip != null) {
    const pr = getPrefs(); const x = pr.chips[Number(t.dataset.chip)]; const f = t.dataset.field;
    x[f] = f === 'c' ? t.value : Math.max(0, Math.floor(Number(t.value) || 0));
    store(LS_PREFS, pr);
    const el = document.getElementById('chip-plan'); if (el) el.innerHTML = chipTable(Number(pr.startStack) || 0, pr.players.length, pr.chips, parseSchedule(pr.schedule));
    if (f === 'c') t.previousElementSibling.style.setProperty('--c', CHIP_COLORS[t.value] || '#888');
    return;
  }
  if (t.dataset.prefPlayer != null) { const pr = getPrefs(); pr.players[Number(t.dataset.prefPlayer)] = t.value; store(LS_PREFS, pr); }
  else if (t.dataset.pref) {
    const pr = getPrefs(); const k = t.dataset.pref;
    pr[k] = t.type === 'checkbox' ? t.checked : (t.type === 'number' ? Number(t.value) : t.value);
    store(LS_PREFS, pr);
    const cp = document.getElementById('chip-plan'); if (cp && (k === 'startStack' || k === 'schedule')) cp.innerHTML = chipTable(Number(pr.startStack) || 0, pr.players.length, pr.chips, parseSchedule(pr.schedule));
  } else if (t.dataset.est) { S.r.estimates[t.dataset.est] = parseNum(t.value); save(); }
  else if (t.dataset.contrib) { S.r.contrib = S.r.contrib || {}; S.r.contrib[t.dataset.contrib] = parseNum(t.value); save(); }
  else if (t.dataset.pname) { byId(t.dataset.pname).name = t.value; save(); }
  else if (t.dataset.pstack) { const v = parseNum(t.value); if (!isNaN(v) && v >= 0) { byId(t.dataset.pstack).stack = Math.floor(v); save(); } }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.pref === 'tts' || t.dataset.pref === 'builtin') render();
  if (t.dataset.voice != null) { const pr = getPrefs(); pr.voice = t.value; store(LS_PREFS, pr); speak('So klinge ich.', true); }
  if (t.dataset.rate != null) { const pr = getPrefs(); pr.rate = Number(t.value); store(LS_PREFS, pr); render(); speak('So schnell spreche ich jetzt.', true); }
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
  if (e.key === 'Tab' && modal) {
    const f = [...document.querySelectorAll('.modal button:not(:disabled), .modal input, .modal select, .modal [href]')].filter((x) => x.offsetParent !== null);
    if (f.length) {
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement?.classList.contains('modal'))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
  if (modal || !S || S.screen !== 'game') return;
  if (e.key === 'Enter' && (document.activeElement?.dataset.est != null || document.activeElement?.dataset.contrib != null)) {
    const all = [...document.querySelectorAll('[data-est],[data-contrib]')];
    const i = all.indexOf(document.activeElement);
    if (i < all.length - 1) { all[i + 1].focus(); e.preventDefault(); return; }
    e.preventDefault(); next(); return;
  }
  if (e.key === 'Enter' && document.activeElement?.id === 'raise-to') { e.preventDefault(); $('[data-act="raise"]')?.click(); return; }
  if (typing) return;
  const onOtherButton = /^(BUTTON|A)$/.test(document.activeElement?.tagName || '') && !document.activeElement.classList.contains('primary');
  if (e.key === ' ' && onOtherButton) return; // Leertaste löst den fokussierten Button aus, nicht „Weiter“
  if ((e.key === ' ' || e.key === 'ArrowRight') && $('.primary')) { e.preventDefault(); next(); }
  if ((e.key === 'z' && (e.ctrlKey || e.metaKey)) || e.key === 'Backspace') { e.preventDefault(); undo(); }
});

if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
render();
