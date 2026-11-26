'use strict';
/* =========================================================
   Schätzpoker – Handy-Verbindung (Host-Seite)
   Die Hauptseite ist der Spieltisch. Handys verbinden sich per
   WebRTC (PeerJS) direkt mit ihr. Die Hauptseite prüft jeden Zug
   und schickt jedem Handy nur das, was es sehen darf.
   ========================================================= */
window.Remote = (() => {
  const PREFIX = 'schaetzpoker-v1-';
  let peer = null;
  let status = 'off';     // off | connecting | online | error
  let err = '';
  let pendingRender = false;
  let retryAt = 0;
  const conns = new Map(); // connectionId -> { conn, pid }

  /* ---------- Hilfen ---------- */
  function peerOpts() {
    // ?peer=host:port erlaubt einen eigenen PeerJS-Server (z. B. zum Testen)
    const q = new URLSearchParams(location.search).get('peer');
    if (!q) return { debug: 0 };
    const [host, port] = q.split(':');
    return { host, port: Number(port) || 443, path: '/', secure: location.protocol === 'https:' && host !== 'localhost', debug: 0 };
  }
  function randId() {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
  }
  function roomId() {
    if (!S.room) { S.room = randId(); store(LS_STATE, S); }
    return S.room;
  }
  function joinUrl() {
    const u = new URL('player.html', location.href);
    u.search = location.search;
    u.hash = roomId();
    return u.toString();
  }
  function isLinked(pid) {
    for (const e of conns.values()) if (e.pid === pid && e.conn.open) return true;
    return false;
  }
  function linkedCount() { return S ? S.players.filter((p) => isLinked(p.id)).length : 0; }

  // Neu zeichnen, ohne dem Spielleiter ein Eingabefeld unter den Fingern wegzuziehen
  function softRender() {
    const a = document.activeElement;
    if (a && a.tagName === 'INPUT' && a.closest('#app')) { pendingRender = true; return; }
    render();
  }
  document.addEventListener('focusout', () => {
    if (pendingRender) setTimeout(() => {
      const a = document.activeElement;
      if (!(a && a.tagName === 'INPUT' && a.closest('#app'))) { pendingRender = false; render(); }
    }, 0);
  });

  /* ---------- Verbindung ---------- */
  function start() {
    if (peer || !S || S.screen === 'setup' || !S.settings.remote || Date.now() < retryAt) return;
    if (typeof Peer === 'undefined') { status = 'error'; err = 'Verbindungs-Bibliothek konnte nicht geladen werden.'; return; }
    status = 'connecting';
    peer = new Peer(PREFIX + roomId(), peerOpts());
    peer.on('open', () => { status = 'online'; err = ''; softRender(); });
    peer.on('connection', (c) => {
      const entry = { conn: c, pid: null };
      conns.set(c.connectionId, entry);
      c.on('open', () => send(entry));
      c.on('data', (d) => { try { onData(entry, d); } catch (e) { console.error(e); } });
      c.on('close', () => { conns.delete(c.connectionId); softRender(); });
      c.on('error', () => { conns.delete(c.connectionId); softRender(); });
    });
    peer.on('disconnected', () => {
      status = 'connecting'; softRender();
      setTimeout(() => { try { if (peer && !peer.destroyed) peer.reconnect(); } catch { /* egal */ } }, 1500);
    });
    peer.on('error', (e) => {
      if (e.type === 'unavailable-id') {
        // z. B. nach Neuladen: die alte Sitzung ist beim Server noch nicht abgemeldet
        err = 'Raum wird noch freigegeben – neuer Versuch …'; status = 'connecting';
        destroy(true); retryAt = Date.now() + 4000; setTimeout(start, 4100);
      } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') {
        err = 'Keine Verbindung zum Vermittlungs-Server. Ist das Internet an?'; status = 'error';
        destroy(true); retryAt = Date.now() + 5000; setTimeout(start, 5100);
      } else if (e.type !== 'peer-unavailable') {
        err = String(e.type || e); status = 'error';
      }
      softRender();
    });
  }
  function destroy(keepStatus) {
    try { if (peer) peer.destroy(); } catch { /* egal */ }
    peer = null; conns.clear();
    if (!keepStatus) { status = 'off'; err = ''; }
  }

  function send(entry, msg) {
    try { if (entry.conn.open) entry.conn.send(msg || view(entry.pid)); } catch { /* egal */ }
  }
  function broadcast() {
    if (!peer) return;
    for (const e of conns.values()) send(e);
  }

  /* ---------- Nachrichten vom Handy ---------- */
  function onData(entry, d) {
    if (!d || typeof d !== 'object' || !S) return;
    switch (d.t) {
      case 'hello': send(entry); break;
      case 'claim': {
        const p = S.players.find((x) => x.id === d.pid);
        if (!p) return send(entry, { t: 'error', msg: 'Diesen Spieler gibt es nicht mehr.' });
        if (p.out && isChips()) return send(entry, { t: 'error', msg: `${p.name} ist schon ausgeschieden.` });
        S.remote = S.remote || {};
        const token = String(d.token || '');
        const otherOpen = [...conns.values()].some((e) => e !== entry && e.pid === d.pid && e.conn.open);
        if (otherOpen && S.remote[d.pid] !== token) {
          return send(entry, { t: 'error', msg: `${p.name} ist schon mit einem anderen Handy verbunden.` });
        }
        for (const e of conns.values()) if (e !== entry && e.pid === d.pid) { e.pid = null; send(e, { t: 'kicked' }); }
        S.remote[d.pid] = token;
        entry.pid = d.pid;
        save(); softRender();
        break;
      }
      case 'leave': entry.pid = null; send(entry); softRender(); break;
      case 'est': {
        if (!entry.pid || S.screen !== 'game' || !S.r) return;
        if (S.r.phase !== 'question') return send(entry, { t: 'error', msg: 'Schätzen geht nur, solange die Frage offen ist.' });
        const v = Number(d.v);
        if (!isFinite(v)) return send(entry, { t: 'error', msg: 'Bitte eine Zahl eingeben.' });
        S.r.estimates[entry.pid] = v;
        save(); softRender();
        break;
      }
      case 'act': handleAct(entry, d); break;
    }
  }

  function handleAct(entry, d) {
    if (!isChips() || S.screen !== 'game') return;
    const r = S.r;
    if (!r.phase.startsWith('bet') || r.betDone || r.toAct < 0 || d.phase !== r.phase) return send(entry);
    const p = P(r.toAct);
    if (p.id !== entry.pid) return send(entry, { t: 'error', msg: 'Du bist gerade nicht dran.' });
    const h = H(p);
    const maxTo = h.inRound + p.stack;
    const minTo = Math.min(r.currentBet === 0 ? r.bb : r.currentBet + r.minRaise, maxTo);
    const toCall = Math.max(0, r.currentBet - h.inRound);
    const wasOpen = r.currentBet === 0;
    let msg = '';
    if (d.a === 'fold') { act('fold'); msg = `${p.name} passt`; }
    else if (d.a === 'call') { act('call'); msg = toCall > 0 ? `${p.name} geht mit (${fmt(Math.min(toCall, p.stack))})` : `${p.name} checkt`; }
    else if (d.a === 'allin') { act('raise', maxTo); msg = `${p.name} geht All-in (${fmt(maxTo)})`; }
    else if (d.a === 'raise') {
      const v = Math.floor(Number(d.v));
      if (!(v >= minTo)) return send(entry, { t: 'error', msg: `Mindestens ${fmt(minTo)}.` });
      const target = Math.min(v, maxTo);
      act('raise', target);
      msg = `${p.name} ${wasOpen ? 'setzt' : 'erhöht auf'} ${fmt(target)}`;
    } else return;
    toast(msg);
  }

  /* ---------- Sicht eines Spielers (nichts Geheimes!) ---------- */
  function view(pid) {
    const base = { t: 'state', room: S ? S.room : null };
    if (!S || S.screen === 'setup' || !S.r) return { ...base, screen: 'setup' };
    const r = S.r; const ph = r.phase; const pi = PHASES.indexOf(ph);
    const chips = isChips();
    const players = S.players.map((p, i) => {
      const h = r.hand[p.id];
      const e = r.estimates[p.id];
      return {
        id: p.id, name: p.name, stack: chips ? p.stack : null, out: p.out,
        bet: h && !r.result ? h.inRound : 0, folded: !!(h && h.folded), allIn: !!(h && h.allIn),
        dealer: i === S.dealer, sb: i === r.sbIdx, bb: i === r.bbIdx,
        linked: isLinked(p.id), estDone: e != null && !isNaN(e)
      };
    });
    const q = pi >= 1 ? {
      q: r.q.q, unit: r.q.unit || '',
      h1: pi >= PHASES.indexOf('hint1') ? r.q.h1 : null,
      h2: pi >= PHASES.indexOf('hint2') ? r.q.h2 : null,
      a: ph === 'result' ? r.q.a : null,
      info: ph === 'result' ? (r.q.info || '') : null
    } : null;
    let me = null;
    const p = pid ? byId(pid) : null;
    if (p) {
      const h = r.hand[pid]; const e = r.estimates[pid];
      me = { id: pid, est: e != null && !isNaN(e) ? e : null, turn: null };
      if (chips && h && r.toAct >= 0 && P(r.toAct).id === pid && ph.startsWith('bet') && !r.betDone) {
        const toCall = Math.min(Math.max(0, r.currentBet - h.inRound), p.stack);
        const maxTo = h.inRound + p.stack;
        const minTo = Math.min(r.currentBet === 0 ? r.bb : r.currentBet + r.minRaise, maxTo);
        me.turn = { toCall, maxTo, minTo, canRaise: maxTo > r.currentBet && p.stack > toCall, currentBet: r.currentBet, inRound: h.inRound, pot: pot(), step: r.sb };
      }
    }
    const result = ph === 'result' && r.result ? { ranking: r.result.ranking, pots: r.result.pots || [], foldWin: r.foldWin || null } : null;
    return {
      ...base, screen: S.screen, mode: S.settings.mode, round: S.round, rounds: S.settings.rounds,
      sb: r.sb, bb: r.bb, levelUp: r.levelUp, phase: ph,
      toAct: chips && r.toAct >= 0 && ph.startsWith('bet') && !r.betDone ? P(r.toAct).id : null,
      betDone: !!r.betDone, currentBet: r.currentBet, pot: chips ? pot() : 0,
      players, q, me, result
    };
  }

  /* ---------- Host-Oberfläche ---------- */
  function qrSvg(text) {
    if (typeof qrcode === 'undefined') return '';
    const qr = qrcode(0, 'M');
    qr.addData(text); qr.make();
    return qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  }
  function renderModal() {
    if (!S || S.screen === 'setup') return '<h2>Handys verbinden</h2><p class="sub">Starte zuerst ein Spiel.</p>';
    if (!S.settings.remote) return `<h2>Handys verbinden</h2><p class="sub">Die Handy-Verbindung ist für dieses Spiel aus.</p>
      <button class="btn gold" data-act="remote-on">Jetzt einschalten</button>`;
    const url = joinUrl();
    const st = status === 'online' ? '<span class="dot on"></span>Bereit – Handys können beitreten'
      : status === 'error' ? `<span class="dot err"></span>${esc(err)}`
      : `<span class="dot wait"></span>${esc(err || 'Verbinde mit dem Vermittlungs-Server …')}`;
    return `
      <h2>Handys verbinden</h2>
      <div class="join">
        <div class="qr">${qrSvg(url)}</div>
        <div class="join-info">
          <p class="lead">QR-Code mit der Handy-Kamera scannen, Namen antippen – fertig.</p>
          <p class="sub small">Raum-Code: <b class="room">${esc(roomId())}</b></p>
          <p class="status">${st}</p>
          <div class="row-btns"><input type="text" readonly value="${esc(url)}" id="join-url"><button class="btn ghost sm" data-act="copy-url">Kopieren</button></div>
        </div>
      </div>
      <h3 class="mini-h">Spieler</h3>
      <div class="linked">${S.players.map((p) => `
        <div class="lk ${isLinked(p.id) ? 'on' : ''}"><span class="dot ${isLinked(p.id) ? 'on' : ''}"></span><b>${esc(p.name)}</b>
          <span>${isLinked(p.id) ? 'verbunden' : 'nicht verbunden'}</span>
          ${isLinked(p.id) ? `<button class="btn ghost sm" data-act="remote-kick" data-id="${p.id}">Trennen</button>` : ''}</div>`).join('')}</div>
      <p class="sub small">Alle Geräte brauchen Internet (WLAN oder mobile Daten). Die Verbindung läuft direkt zwischen den Geräten. Wer sein Handy nicht nutzen will, spielt einfach über diesen Bildschirm weiter.</p>`;
  }
  function onClick(a, el) {
    switch (a) {
      case 'copy-url': {
        const i = document.getElementById('join-url');
        if (navigator.clipboard) navigator.clipboard.writeText(i.value).then(() => toast('Link kopiert.'), () => { i.select(); });
        else i.select();
        return true;
      }
      case 'remote-on': S.settings.remote = true; save(); start(); render(); return true;
      case 'remote-kick': {
        const pid = el.dataset.id;
        for (const e of conns.values()) if (e.pid === pid) { e.pid = null; send(e, { t: 'kicked' }); }
        if (S.remote) delete S.remote[pid];
        save(); render(); return true;
      }
    }
    return false;
  }
  function badge() {
    if (!S || !S.settings.remote) return '';
    const n = linkedCount();
    return n ? `<span class="badge">${n}</span>` : '';
  }

  return { start, destroy, broadcast, renderModal, onClick, isLinked, linkedCount, badge, view, get status() { return status; } };
})();

// Falls ein laufendes Spiel schon angezeigt wird (Seite neu geladen): Verbindung starten
if (typeof S !== 'undefined' && S && S.screen !== 'setup') Remote.start();
