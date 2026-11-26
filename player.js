'use strict';
/* =========================================================
   Schätzpoker – Handy-Seite für Spieler
   Verbindet sich per WebRTC mit dem Spieltisch (Hauptseite).
   ========================================================= */
(() => {
  const PREFIX = 'schaetzpoker-v1-';
  const room = (location.hash.slice(1) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const LS_TOKEN = 'sp_tok_' + room;
  const LS_PID = 'sp_pid_' + room;

  let peer = null;
  let conn = null;
  let status = room ? 'connecting' : 'noroom'; // connecting | online | nohost | noroom | error
  let st = null;            // letzter Zustand vom Tisch
  let pid = ls(LS_PID);
  let token = ls(LS_TOKEN);
  if (!token) { token = Math.random().toString(36).slice(2) + Date.now().toString(36); lsSet(LS_TOKEN, token); }
  let raiseVal = null;
  let estDraft = '';
  let editEst = false;
  let lastTurnKey = '';
  let pendingRender = false;
  let retryTimer = null;
  let wakeLock = null;

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 3 });
  const fmt = (n) => (n == null || isNaN(n) ? '–' : nf.format(n));
  const fmtA = (q, n) => (q && q.unit === '' && Number.isInteger(n) && n > 999 && n < 2200 ? String(n) : fmt(n));
  function ls(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* egal */ } }
  function parseNum(s) {
    s = String(s ?? '').trim().replace(/[\s']/g, '');
    if (!s) return NaN;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    const n = Number(s);
    return isFinite(n) ? n : NaN;
  }

  /* ---------- Verbindung ---------- */
  function peerOpts() {
    const q = new URLSearchParams(location.search).get('peer');
    if (!q) return { debug: 0 };
    const [host, port] = q.split(':');
    return { host, port: Number(port) || 443, path: '/', secure: location.protocol === 'https:' && host !== 'localhost', debug: 0 };
  }
  function boot() {
    if (!room) return render();
    if (typeof Peer === 'undefined') { status = 'error'; return render(); }
    peer = new Peer(undefined, peerOpts());
    peer.on('open', connect);
    peer.on('disconnected', () => { setTimeout(() => { try { if (!peer.destroyed) peer.reconnect(); } catch { /* egal */ } }, 1000); });
    peer.on('error', (e) => {
      if (e.type === 'peer-unavailable') { status = 'nohost'; render(); retry(3000); }
      else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') { status = 'error'; render(); retry(4000); }
    });
  }
  function retry(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (!peer || peer.destroyed) { peer = null; return boot(); }
      if (peer.disconnected) { try { peer.reconnect(); } catch { /* egal */ } return retry(1500); }
      connect();
    }, ms);
  }
  function connect() {
    if (conn) { try { conn.close(); } catch { /* egal */ } }
    conn = peer.connect(PREFIX + room, { reliable: true });
    conn.on('open', () => {
      status = 'online';
      send({ t: 'hello' });
      if (pid) send({ t: 'claim', pid, token });
      render();
    });
    conn.on('data', onData);
    conn.on('close', () => { status = 'nohost'; render(); retry(1500); });
    conn.on('error', () => { status = 'nohost'; render(); retry(2000); });
  }
  function send(m) { try { if (conn && conn.open) conn.send(m); } catch { /* egal */ } }

  function onData(d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'error') { toast(d.msg); return; }
    if (d.t === 'kicked') { pid = null; lsSet(LS_PID, null); toast('Du wurdest vom Tisch getrennt.'); render(); return; }
    if (d.t !== 'state') return;
    const prev = st;
    st = d;
    // Ich bin (noch) nicht zugeordnet, habe aber einen gespeicherten Platz → neu anmelden
    if (pid && !d.me && d.players && d.players.some((p) => p.id === pid)) send({ t: 'claim', pid, token });
    if (pid && d.players && !d.players.some((p) => p.id === pid)) { pid = null; lsSet(LS_PID, null); }
    // Neue Runde/Phase → Entwürfe zurücksetzen
    if (!prev || prev.round !== d.round) { estDraft = ''; editEst = false; }
    if (!prev || prev.phase !== d.phase || prev.toAct !== d.toAct) raiseVal = null;
    // Du bist dran → vibrieren
    const turnKey = d.me && d.me.turn ? `${d.round}-${d.phase}-${d.currentBet}-${d.pot}` : '';
    if (turnKey && turnKey !== lastTurnKey) { buzz(); }
    lastTurnKey = turnKey;
    // Nicht neu zeichnen, während getippt wird (sonst geht die Tastatur zu)
    const a = document.activeElement;
    const typing = a && a.tagName === 'INPUT';
    const sameView = prev && prev.phase === d.phase && prev.toAct === d.toAct && prev.round === d.round;
    if (typing && sameView) { pendingRender = true; return; }
    render();
  }
  document.addEventListener('focusout', () => {
    if (!pendingRender) return;
    setTimeout(() => { const a = document.activeElement; if (!(a && a.tagName === 'INPUT')) { pendingRender = false; render(); } }, 0);
  });

  function buzz() {
    try { if (navigator.vibrate) navigator.vibrate([180, 90, 180]); } catch { /* egal */ }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      o.start(); o.stop(ctx.currentTime + 0.27);
    } catch { /* egal */ }
  }
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* egal */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { keepAwake(); if (status !== 'online') retry(200); } });

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
  }

  /* ---------- Darstellung ---------- */
  const PH = ['intro', 'question', 'bet0', 'hint1', 'bet1', 'hint2', 'bet2', 'showdown', 'result'];
  const meP = () => (st && st.players ? st.players.find((p) => p.id === pid) : null);
  const nameOf = (id) => { const p = st.players.find((x) => x.id === id); return p ? p.name : '?'; };

  function render() {
    const app = $('#app');
    if (status === 'noroom') { app.innerHTML = screenMsg('Kein Spieltisch gefunden', 'Scanne den QR-Code, der auf dem Spieltisch-Bildschirm über das Handy-Symbol oben angezeigt wird.'); return; }
    if (!st) {
      const msg = status === 'nohost' ? 'Der Spieltisch ist gerade nicht erreichbar. Ist die Seite dort offen? Neuer Versuch läuft …'
        : status === 'error' ? 'Keine Verbindung. Hast du Internet (WLAN oder mobile Daten)? Neuer Versuch läuft …'
        : 'Verbinde mit dem Spieltisch …';
      app.innerHTML = screenMsg(`Raum ${esc(room)}`, msg, true); return;
    }
    if (st.screen === 'setup') { app.innerHTML = screenMsg('Gleich geht’s los', 'Der Spielleiter richtet gerade das Spiel ein.', true); return; }
    if (!pid || !meP()) { app.innerHTML = renderPick(); return; }
    app.innerHTML = renderMain();
  }
  function screenMsg(title, text, spin) {
    return `<div class="pl-center"><div class="pl-logo" aria-hidden="true">?</div><h1>${title}</h1><p class="sub">${text}</p>${spin ? '<div class="spinner"></div>' : ''}</div>`;
  }
  function renderPick() {
    const list = st.players.filter((p) => !(p.out && st.mode === 'chips'));
    return `
      <div class="pl-center">
        <div class="pl-logo" aria-hidden="true">?</div>
        <h1>Wer bist du?</h1>
        <p class="sub">Tippe auf deinen Namen.</p>
        <div class="pick">${list.map((p) => `
          <button class="btn ${p.linked ? 'ghost' : 'gold'} big" data-act="claim" data-id="${esc(p.id)}" ${p.linked ? 'disabled' : ''}>
            ${esc(p.name)}${p.linked ? '<small>schon verbunden</small>' : ''}</button>`).join('')}</div>
        <p class="sub small">Dein Name fehlt? Sag dem Spielleiter Bescheid – er kann dich unter „Spieler“ hinzufügen.</p>
      </div>`;
  }

  function renderMain() {
    const me = meP(); const chips = st.mode === 'chips';
    const ph = st.phase; const pi = PH.indexOf(ph);
    const roles = [me.dealer ? '<i class="m d">D</i>' : '', me.sb ? '<i class="m sb">SB</i>' : '', me.bb ? '<i class="m bb">BB</i>' : ''].join('');
    const head = `
      <header class="pl-head">
        <div class="pl-me"><b>${esc(me.name)}</b>${roles}<button class="link" data-act="switch">wechseln</button></div>
        ${chips ? `<div class="pl-stack"><small>Deine Chips</small><b>${fmt(me.stack)}</b></div>` : ''}
        <div class="pl-meta"><span>Runde <b>${st.round}${st.rounds ? '/' + st.rounds : ''}</b></span><span>Blinds <b>${fmt(st.sb)}/${fmt(st.bb)}</b></span>${chips ? `<span>Pot <b>${fmt(st.pot)}</b></span>` : ''}</div>
      </header>`;
    if (st.screen === 'end') return head + renderEnd();
    let body = '';
    if (ph === 'intro') {
      body = `<div class="pl-card center"><div class="kick">Runde ${st.round}</div>
        ${st.levelUp ? '<div class="levelup">Die Blinds steigen!</div>' : ''}
        <p class="sub">${me.sb ? `Du zahlst den <b>Small Blind (${fmt(st.sb)})</b>.` : me.bb ? `Du zahlst den <b>Big Blind (${fmt(st.bb)})</b>.` : 'Gleich kommt die Frage.'}</p></div>`;
    } else {
      const myTurn = !!(st.me && st.me.turn);
      body = (myTurn ? betCard() : '') + questionCard(pi) + estimateCard(ph) + (chips && ph.startsWith('bet') && !myTurn ? betCard() : '') + (ph === 'showdown' ? `<div class="pl-card center"><b class="big-t">Showdown!</b><p class="sub">${me.folded ? 'Du hast gepasst.' : 'Gleich wird aufgelöst – der Spielleiter deckt die Lösung auf.'}</p></div>` : '') + (ph === 'result' ? resultCard() : '');
      if (!chips && ph.startsWith('bet')) body += `<div class="pl-card center"><p class="sub">Setzrunde ${Number(ph.slice(3)) + 1} – gesetzt wird mit echten Chips am Tisch.</p></div>`;
    }
    return head + `<main class="pl-main">${body}${tableCard()}</main>`;
  }

  function questionCard(pi) {
    const q = st.q; if (!q) return '';
    return `<div class="qcard slip">
      <div class="qlabel"><span>Frage ${st.round}</span>${q.unit ? `<span>Antwort in <b>${esc(q.unit)}</b></span>` : ''}</div>
      <h2 class="qtext">${esc(q.q)}</h2>
    </div>
    ${q.h1 ? `<div class="hint"><span class="hint-n">Hinweis 1</span><p>${esc(q.h1)}</p></div>` : ''}
    ${q.h2 ? `<div class="hint"><span class="hint-n">Hinweis 2</span><p>${esc(q.h2)}</p></div>` : ''}`;
  }

  function estimateCard(ph) {
    const me = meP(); const est = st.me ? st.me.est : null; const unit = st.q && st.q.unit ? esc(st.q.unit) : '';
    if (ph === 'result') return '';
    if (ph === 'question') {
      if (est != null && !editEst) {
        return `<div class="pl-card est-done"><small>Deine geheime Schätzung</small><b>${fmtA(st.q, est)} <span>${unit}</span></b>
          <button class="btn ghost sm" data-act="est-edit">Ändern</button><p class="sub small">Ändern geht nur, solange die Frage offen ist.</p></div>`;
      }
      return `<div class="pl-card">
        <label class="est-label">Deine Schätzung <small>(sieht niemand)</small>
          <div class="est-row"><input id="est" type="text" inputmode="decimal" autocomplete="off" placeholder="Zahl eingeben" value="${esc(estDraft || (est != null ? String(est).replace('.', ',') : ''))}">${unit ? `<em>${unit}</em>` : ''}</div></label>
        <button class="btn gold big full" data-act="est-send">Schätzung abgeben</button>
      </div>`;
    }
    if (me.folded) return '';
    return est != null
      ? `<div class="pl-card est-done slim"><small>Deine Schätzung</small><b>${fmtA(st.q, est)} <span>${unit}</span></b></div>`
      : `<div class="pl-card slim"><p class="sub small">Keine Schätzung im Handy – nimm deinen Zettel, der Spielleiter trägt sie beim Aufdecken ein.</p></div>`;
  }

  function betCard() {
    const t = st.me && st.me.turn; const me = meP();
    const k = Number(st.phase.slice(3)) + 1;
    if (me.folded) return `<div class="pl-card center"><p class="sub">Du hast gepasst. Warte auf die nächste Runde.</p></div>`;
    if (st.betDone) return `<div class="pl-card center"><b>Setzrunde ${k} abgeschlossen</b><p class="sub">Gleich geht’s weiter.</p></div>`;
    if (!t) {
      return `<div class="pl-card center wait"><small>Setzrunde ${k} von 3</small><p class="sub"><b>${esc(nameOf(st.toAct))}</b> ist dran …</p>
        ${me.allIn ? '<p class="sub small">Du bist All-in – du musst nichts mehr tun.</p>' : `<p class="sub small">Du hast diese Runde <b>${fmt(me.bet)}</b> gesetzt. Höchster Einsatz: <b>${fmt(st.currentBet)}</b>.</p>`}</div>`;
    }
    if (raiseVal == null) raiseVal = t.minTo;
    const round = (x) => Math.max(t.minTo, Math.min(t.maxTo, Math.round(x / t.step) * t.step));
    const half = round(t.currentBet + (t.pot + t.toCall) / 2);
    const full = round(t.currentBet + t.pot + t.toCall);
    const callLabel = t.toCall <= 0 ? 'Checken' : t.toCall >= me.stack ? `All-in mitgehen ${fmt(t.toCall)}` : `Mitgehen ${fmt(t.toCall)}`;
    return `<div class="pl-card turn">
      <div class="turn-head"><b>Du bist dran!</b><small>Setzrunde ${k} von 3</small></div>
      <p class="sub small">Höchster Einsatz <b>${fmt(t.currentBet)}</b> · du hast <b>${fmt(t.inRound)}</b> gesetzt${t.toCall > 0 ? ` · zu zahlen <b>${fmt(t.toCall)}</b>` : ''}</p>
      <div class="pl-actions">
        <button class="btn red big" data-act="a-fold">Passen</button>
        <button class="btn green big" data-act="a-call">${callLabel}</button>
      </div>
      ${t.canRaise ? `
      <div class="pl-raise">
        <label>${t.currentBet === 0 ? 'Setzen' : 'Erhöhen auf'}
          <div class="raise-line">
            <button class="icon-btn" data-act="r-minus" aria-label="weniger">−</button>
            <input id="raise" type="text" inputmode="numeric" value="${raiseVal}">
            <button class="icon-btn" data-act="r-plus" aria-label="mehr">+</button>
          </div></label>
        <div class="quick">
          <button class="chip-btn" data-act="r-set" data-v="${t.minTo}">Min</button>
          <button class="chip-btn" data-act="r-set" data-v="${half}">½ Pot</button>
          <button class="chip-btn" data-act="r-set" data-v="${full}">Pot</button>
        </div>
        <button class="btn gold big full" data-act="a-raise">${t.currentBet === 0 ? 'Setzen' : 'Erhöhen auf'} <span id="raise-lbl">${fmt(raiseVal)}</span></button>
      </div>` : ''}
      <button class="btn ghost full allin-btn" data-act="a-allin">All-in (${fmt(t.maxTo)})</button>
    </div>`;
  }

  function resultCard() {
    const q = st.q; const res = st.result || { ranking: [], pots: [] };
    const rank = res.ranking || [];
    const best = rank.length ? rank[0].dist : null;
    let mine = '';
    if (st.mode === 'chips') {
      const won = (res.pots || []).filter((p) => p.winners.includes(pid)).reduce((s, p) => s + Math.floor(p.amount / p.winners.length), 0);
      mine = won > 0 ? `<div class="won">Du gewinnst ${fmt(won)}!</div>` : '';
    }
    return `<div class="pl-card center">
      <small>Die richtige Antwort</small>
      <div class="pl-answer">${fmtA(q, Number(q.a))} <span>${esc(q.unit)}</span></div>
      ${q.info ? `<p class="sub small">${esc(q.info)}</p>` : ''}
      ${mine}
      ${res.foldWin ? `<p class="sub"><b>${esc(nameOf(res.foldWin.id))}</b> gewinnt – alle anderen haben gepasst.</p>` : ''}
      ${rank.length ? `<ol class="ranking">${rank.map((x) => `<li class="${Math.abs(x.dist - best) < 1e-9 ? 'best' : ''} ${x.id === pid ? 'me' : ''}">
        <span class="n">${esc(nameOf(x.id))}</span><span class="e">${fmtA(q, x.est)}</span><span class="d">${x.dist === 0 ? 'exakt!' : '± ' + fmt(x.dist)}</span></li>`).join('')}</ol>` : ''}
    </div>`;
  }

  function tableCard() {
    const chips = st.mode === 'chips';
    return `<div class="pl-card table-mini"><small>Am Tisch</small><ul>${st.players.map((p) => `
      <li class="${p.out ? 'out' : ''} ${p.folded ? 'folded' : ''} ${p.id === st.toAct ? 'turn' : ''} ${p.id === pid ? 'me' : ''}">
        <span class="nm">${esc(p.name)}${p.dealer ? ' <i class="m d">D</i>' : ''}${p.sb ? ' <i class="m sb">SB</i>' : ''}${p.bb ? ' <i class="m bb">BB</i>' : ''}</span>
        <span class="v">${p.out ? 'raus' : p.folded ? 'gepasst' : p.allIn ? 'all-in' : ''}${chips && !p.out ? ` <b>${fmt(p.stack)}</b>` : ''}${chips && p.bet ? ` <em>● ${fmt(p.bet)}</em>` : ''}${!chips && st.phase === 'question' && p.estDone ? ' ✓' : ''}</span>
      </li>`).join('')}</ul></div>`;
  }

  function renderEnd() {
    const list = st.players.slice().sort((a, b) => (b.stack || 0) - (a.stack || 0));
    return `<main class="pl-main"><div class="pl-card center"><div class="kick">Spielende</div>
      ${st.mode === 'chips' ? `<p class="sub"><b>${esc(list[0].name)}</b> gewinnt mit <b>${fmt(list[0].stack)}</b> Chips.</p>
      <ol class="ranking">${list.map((p) => `<li class="${p.id === pid ? 'me' : ''}"><span class="n">${esc(p.name)}</span><span class="e">${fmt(p.stack)}</span></li>`).join('')}</ol>` : '<p class="sub">Danke fürs Mitspielen!</p>'}
    </div></main>`;
  }

  /* ---------- Eingaben ---------- */
  document.addEventListener('click', (e) => {
    keepAwake();
    const el = e.target.closest('[data-act]'); if (!el) return;
    const a = el.dataset.act;
    const t = st && st.me && st.me.turn;
    switch (a) {
      case 'claim': pid = el.dataset.id; lsSet(LS_PID, pid); send({ t: 'claim', pid, token }); render(); break;
      case 'switch': send({ t: 'leave' }); pid = null; lsSet(LS_PID, null); render(); break;
      case 'est-edit': editEst = true; render(); $('#est')?.focus(); break;
      case 'est-send': {
        const v = parseNum($('#est').value);
        if (isNaN(v)) return toast('Bitte eine Zahl eingeben.');
        estDraft = ''; editEst = false; send({ t: 'est', v });
        if (document.activeElement) document.activeElement.blur();
        toast('Schätzung abgegeben ✓');
        break;
      }
      case 'a-fold': if (t) { send({ t: 'act', a: 'fold', phase: st.phase }); lock(); } break;
      case 'a-call': if (t) { send({ t: 'act', a: 'call', phase: st.phase }); lock(); } break;
      case 'a-allin': if (t) { send({ t: 'act', a: 'allin', phase: st.phase }); lock(); } break;
      case 'a-raise': {
        if (!t) break;
        const v = parseNum($('#raise').value);
        if (isNaN(v) || v < t.minTo) return toast(`Mindestens ${fmt(t.minTo)}.`);
        send({ t: 'act', a: 'raise', v: Math.min(v, t.maxTo), phase: st.phase }); lock();
        break;
      }
      case 'r-set': setRaise(Number(el.dataset.v)); break;
      case 'r-plus': if (t) setRaise((parseNum($('#raise').value) || t.minTo) + Math.max(t.step, st.bb)); break;
      case 'r-minus': if (t) setRaise((parseNum($('#raise').value) || t.minTo) - Math.max(t.step, st.bb)); break;
    }
  });
  function setRaise(v) {
    const t = st && st.me && st.me.turn; if (!t) return;
    raiseVal = Math.max(t.minTo, Math.min(t.maxTo, Math.round(v)));
    const i = $('#raise'); if (i) i.value = raiseVal;
    const l = $('#raise-lbl'); if (l) l.textContent = fmt(raiseVal);
  }
  // Doppeltippen verhindern, bis der Tisch geantwortet hat
  function lock() { document.querySelectorAll('.turn .btn, .turn .chip-btn').forEach((b) => { b.disabled = true; }); }
  document.addEventListener('input', (e) => {
    if (e.target.id === 'est') estDraft = e.target.value;
    if (e.target.id === 'raise') { const v = parseNum(e.target.value); if (!isNaN(v)) { raiseVal = v; const l = $('#raise-lbl'); if (l) l.textContent = fmt(v); } }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'est') { e.preventDefault(); $('[data-act="est-send"]')?.click(); }
    if (e.target.id === 'raise') { e.preventDefault(); $('[data-act="a-raise"]')?.click(); }
  });

  render();
  boot();
})();
