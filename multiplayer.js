// ================================================================
//  PUMPKIN GUY — multiplayer.js   (ADD-ONLY 2-player co-op layer)
//  Live co-op over Firebase Realtime Database.
//  Nothing in the other files is edited: this file wraps a few
//  globals at runtime and draws the partner on the same canvas.
//
//  Phase 1 (this file): rooms (code / link / public lobby), max 2
//  players, shared world seed, live partner ghost.
//  Next phases: shared enemies + pickups (host is the authority),
//  shared quests, QR code, direct phone-to-phone (WebRTC) link.
// ================================================================
(function () {
  'use strict';

  // ---- settings --------------------------------------------------
  // Same Firebase project as ChemVentur Multi; own paths so nothing clashes.
  var FB_CONFIG = {
    apiKey: "AIzaSyBVViPQjP9f1ZENFNXsCA7rs628FxDayMI",
    authDomain: "chemventurmulti117.firebaseapp.com",
    databaseURL: "https://chemventurmulti117-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "chemventurmulti117",
    storageBucket: "chemventurmulti117.firebasestorage.app",
    messagingSenderId: "323218594439",
    appId: "1:323218594439:web:5ad5e95e896304de1af622"
  };
  var ROOMS = 'pumpkinGuyRooms';
  var LOBBY = 'pumpkinGuyLobby';
  var MAX_PLAYERS = 2;
  var SEND_HZ = 15;
  var SDK_URLS = [
    'https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/9.22.0/firebase-database-compat.js'
  ];
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

  // ---- state -----------------------------------------------------
  var MP = {
    uid: getUid(), db: null, active: false, isHost: false, code: null,
    room: null, meta: null, slots: {}, partner: null, partnerSmooth: null,
    streams: {}, lastStartToken: null, status: 'Not in a room'
  };
  window.PKG_MP = MP;

  function getUid() {
    try {
      var u = localStorage.getItem('pkg_uid');
      if (!u) { u = 'p' + Math.random().toString(36).slice(2, 10); localStorage.setItem('pkg_uid', u); }
      return u;
    } catch (e) { return 'p' + Math.random().toString(36).slice(2, 10); }
  }

  // ---- seeded random (so both players build the same world) ------
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // One independent stream per generator, so the result does not depend on
  // when each player's camera happens to trigger the next chunk.
  MP.stream = function (key) {
    if (!MP.streams[key]) {
      var world = (typeof currentWorld !== 'undefined') ? currentWorld : 'green';
      MP.streams[key] = mulberry32(hashStr(MP.seed + '|' + world + '|' + key));
    }
    return MP.streams[key];
  };

  function wrapSeeded(fnName, key) {
    var orig = window[fnName];
    if (typeof orig !== 'function' || orig.__pkgWrapped) return;
    var wrapped = function () {
      if (!MP.active) return orig.apply(this, arguments);
      var saved = Math.random;
      Math.random = MP.stream(key);
      try { return orig.apply(this, arguments); }
      finally { Math.random = saved; }
    };
    wrapped.__pkgWrapped = true;
    window[fnName] = wrapped;
  }

  function installWrappers() {
    wrapSeeded('genPlats', 'plats');
    wrapSeeded('spawnColls', 'colls');
    wrapSeeded('spawnGuns', 'guns');
    wrapSeeded('spawnEns', 'ens');
    var origInit = window.initWorld;
    if (typeof origInit === 'function' && !origInit.__pkgWrapped) {
      var wi = function (wid) {
        if (MP.active) MP.streams = {}; // fresh identical streams for this world
        return origInit.apply(this, arguments);
      };
      wi.__pkgWrapped = true;
      window.initWorld = wi;
    }
  }

  // ---- firebase loading ------------------------------------------
  function loadSdk(cb, fail) {
    if (window.firebase && window.firebase.database) return cb();
    var i = 0;
    (function next() {
      if (i >= SDK_URLS.length) return cb();
      var s = document.createElement('script');
      s.src = SDK_URLS[i++];
      s.onload = next;
      s.onerror = function () { fail('Could not load Firebase (offline?)'); };
      document.head.appendChild(s);
    })();
  }
  function ensureDb(cb) {
    if (MP.db) return cb();
    loadSdk(function () {
      try {
        if (!window.firebase.apps.length) window.firebase.initializeApp(FB_CONFIG);
        MP.db = window.firebase.database();
        cb();
      } catch (e) { say('Firebase failed: ' + (e && e.message || e)); }
    }, say);
  }

  // ---- rooms -----------------------------------------------------
  function makeCode() {
    var c = '';
    for (var i = 0; i < 4; i++) c += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    return c;
  }
  function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); }

  MP.createRoom = function (world, isPublic) {
    return new Promise(function (resolve) {
      ensureDb(function () {
        (function attempt(n) {
          var code = makeCode();
          var ref = MP.db.ref(ROOMS + '/' + code);
          ref.child('meta').once('value').then(function (s) {
            if (s.exists() && n < 8) return attempt(n + 1);
            var meta = {
              host: MP.uid, world: world || 'green', pub: !!isPublic, state: 'lobby',
              seed: (Math.random() * 4294967296) >>> 0, t: Date.now()
            };
            var upd = {}; upd['meta'] = meta; upd['slots/' + MP.uid] = Date.now();
            return ref.update(upd).then(function () {
              enterRoom(code, true, meta); resolve(code);
            });
          }).catch(function (e) { say('Create failed: ' + (e && e.message || e)); resolve(null); });
        })(0);
      });
    });
  };

  MP.joinRoom = function (code) {
    code = normCode(code);
    return new Promise(function (resolve) {
      if (code.length !== 4) { say('Room codes are 4 characters.'); return resolve(false); }
      ensureDb(function () {
        var ref = MP.db.ref(ROOMS + '/' + code);
        ref.child('meta').once('value').then(function (s) {
          if (!s.exists()) { say('No such room: ' + code); return resolve(false); }
          var meta = s.val();
          return ref.child('slots').transaction(function (cur) {
            cur = cur || {};
            if (cur[MP.uid]) return cur;
            if (Object.keys(cur).length >= MAX_PLAYERS) return; // abort: full
            cur[MP.uid] = Date.now();
            return cur;
          }).then(function (r) {
            if (!r.committed) { say('Room ' + code + ' is full (2 players max).'); return resolve(false); }
            enterRoom(code, false, meta); resolve(true);
          });
        }).catch(function (e) { say('Join failed: ' + (e && e.message || e)); resolve(false); });
      });
    });
  };

  function enterRoom(code, isHost, meta) {
    MP.active = true; MP.code = code; MP.isHost = isHost; MP.meta = meta;
    MP.seed = meta.seed; MP.partner = null; MP.partnerSmooth = null;
    MP.lastStartToken = null; MP.streams = {};
    var ref = MP.room = MP.db.ref(ROOMS + '/' + code);

    ref.child('slots/' + MP.uid).onDisconnect().remove();
    ref.child('players/' + MP.uid).onDisconnect().remove();
    if (isHost) {
      ref.onDisconnect().remove();
      if (meta.pub) {
        var lob = MP.db.ref(LOBBY + '/' + code);
        lob.set({ world: meta.world, t: Date.now() });
        lob.onDisconnect().remove();
      }
    }

    ref.child('meta').on('value', onMeta);
    ref.child('slots').on('value', onSlots);
    ref.child('players').on('value', onPlayers);
    say(isHost ? 'Room ' + code + ' ready. Waiting for player 2…' : 'Joined room ' + code + '. Waiting for host to start…');
    renderPanel();
  }

  function onMeta(snap) {
    if (!MP.active) return;
    if (!snap.exists()) { leaveLocal(); say('The host closed the room.'); return; }
    var m = snap.val(); MP.meta = m; MP.seed = m.seed;
    if (m.state === 'playing' && m.startToken && m.startToken !== MP.lastStartToken) {
      MP.lastStartToken = m.startToken;
      beginGame(m.world);
    }
    renderPanel();
  }
  function onSlots(snap) {
    MP.slots = snap.val() || {};
    var n = Object.keys(MP.slots).length;
    if (MP.active && !MP.gameOn) say(n >= MAX_PLAYERS ? 'Both players are in!' + (MP.isHost ? ' Press Start.' : ' Waiting for host…') : 'Waiting for player 2…');
    if (MP.active && MP.gameOn && n < MAX_PLAYERS) { say('Your partner left.'); MP.partner = null; MP.partnerSmooth = null; }
    renderPanel();
  }
  function onPlayers(snap) {
    var all = snap.val() || {}, other = null;
    for (var k in all) if (k !== MP.uid) other = all[k];
    MP.partner = other;
  }

  MP.start = function (world) {
    if (!MP.active || !MP.isHost) return;
    var w = world || (MP.meta && MP.meta.world) || 'green';
    MP.room.child('meta').update({ state: 'playing', world: w, startToken: Date.now() });
  };

  function beginGame(world) {
    MP.gameOn = true; MP.streams = {};
    installWrappers();
    hidePanel();
    if (typeof window.startGame === 'function') window.startGame(world);
  }

  MP.leave = function () {
    if (!MP.active) return;
    var ref = MP.room, host = MP.isHost, code = MP.code;
    try {
      ref.child('meta').off('value', onMeta);
      ref.child('slots').off('value', onSlots);
      ref.child('players').off('value', onPlayers);
      ref.child('players/' + MP.uid).remove();
      ref.child('slots/' + MP.uid).remove();
      if (host) { ref.remove(); MP.db.ref(LOBBY + '/' + code).remove(); }
    } catch (e) { /* ignore */ }
    leaveLocal();
    say('Left the room.');
  };
  function leaveLocal() {
    MP.active = false; MP.gameOn = false; MP.code = null; MP.room = null;
    MP.partner = null; MP.partnerSmooth = null; MP.slots = {}; MP.streams = {};
    renderPanel();
  }

  MP.listPublic = function () {
    return new Promise(function (resolve) {
      ensureDb(function () {
        MP.db.ref(LOBBY).once('value').then(function (s) {
          var v = s.val() || {}, out = [], now = Date.now();
          for (var c in v) if (now - (v[c].t || 0) < 2 * 3600 * 1000) out.push({ code: c, world: v[c].world });
          resolve(out);
        }).catch(function () { resolve([]); });
      });
    });
  };

  // ---- presence: send my state, draw partner ---------------------
  var lastSend = 0;
  MP.sendState = function () {
    if (!MP.active || !MP.room || typeof P === 'undefined') return;
    MP.room.child('players/' + MP.uid).set({
      x: Math.round(P.x), y: Math.round(P.y),
      vx: Math.round(P.vx * 100) / 100, vy: Math.round(P.vy * 100) / 100,
      f: P.facing, w: P.walking ? 1 : 0, h: P.head, hp: P.hp,
      cw: currentWorld, t: Date.now()
    });
  };

  MP.drawPartner = function () {
    if (!MP.active || !MP.partner || typeof P === 'undefined') return;
    var t = MP.partner;
    if (t.cw !== currentWorld) return;
    var s = MP.partnerSmooth;
    if (!s) s = MP.partnerSmooth = { x: t.x, y: t.y };
    s.x += (t.x + (t.vx || 0) * 2 - s.x) * 0.3;
    s.y += (t.y + (t.vy || 0) * 2 - s.y) * 0.3;
    var real = P;
    var ghost = {};
    for (var k in real) ghost[k] = real[k];
    ghost.x = s.x; ghost.y = s.y; ghost.vx = t.vx || 0; ghost.vy = t.vy || 0;
    ghost.facing = t.f || 1; ghost.walking = !!t.w; ghost.head = t.h || '🎃';
    ghost.hp = t.hp; ghost.invincible = 0; ghost.ohmActive = 0;
    ctx.save();
    ctx.translate(-camX, -camY);
    ctx.globalAlpha = 0.85;
    try { P = ghost; drawChar(); } finally { P = real; }
    ctx.globalAlpha = 1;
    ctx.font = 'bold 13px monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = '#00ff41';
    ctx.fillText('P2', s.x + (ghost.w || 44) / 2, s.y - 14);
    ctx.restore();
  };

  MP.tickOnce = function (nowMs) {
    if (!MP.active) return;
    if (typeof gameRunning !== 'undefined' && gameRunning) {
      if (nowMs - lastSend >= 1000 / SEND_HZ) { lastSend = nowMs; MP.sendState(); }
      MP.drawPartner();
    }
  };
  function loop(ts) {
    requestAnimationFrame(loop);
    try { MP.tickOnce(ts || Date.now()); } catch (e) { /* never break the game */ }
  }

  // ---- small UI (built with plain DOM, no libraries) --------------
  var panel = null;
  function say(msg) { MP.status = msg; var el = document.getElementById('pmStatus'); if (el) el.textContent = msg; }
  function hidePanel() { if (panel) panel.style.display = 'none'; }
  function showPanel() { buildPanel(); panel.style.display = 'block'; renderPanel(); }

  function buildPanel() {
    if (panel) return;
    var st = document.createElement('style');
    st.textContent =
      '#pkgMPBtn{position:fixed;top:8px;right:8px;z-index:9998;background:#041208;color:#00ff41;border:2px solid #00ff41;border-radius:20px;padding:6px 12px;font:bold 13px monospace}' +
      '#pkgMP{position:fixed;inset:0;margin:auto;z-index:9999;display:none;width:min(92vw,340px);max-height:88vh;overflow:auto;background:#041208;color:#d8ffe4;border:2px solid #00ff41;border-radius:12px;padding:12px;font:14px monospace}' +
      '#pkgMP button,#pkgMP select,#pkgMP input[type=text]{font:inherit;background:#0a2a14;color:#d8ffe4;border:1px solid #00ff41;border-radius:8px;padding:8px;margin:4px 2px;min-height:40px}' +
      '#pkgMP .pm-h{display:flex;justify-content:space-between;align-items:center;color:#00ff41;font-weight:800;margin-bottom:6px}' +
      '#pkgMP #pmBig{font-size:40px;letter-spacing:8px;text-align:center;color:#ffe600;margin:8px 0}' +
      '#pkgMP .pm-row{display:flex;gap:4px;align-items:center}' +
      '#pkgMP .pm-soon{opacity:.6;font-size:12px;margin-top:8px}';
    document.head.appendChild(st);

    panel = document.createElement('div');
    panel.id = 'pkgMP';
    var worlds = (typeof WORLDS !== 'undefined') ? Object.keys(WORLDS) : ['green'];
    var opts = worlds.map(function (k) { return '<option value="' + k + '">' + (WORLDS[k].name || k) + '</option>'; }).join('');
    panel.innerHTML =
      '<div class="pm-h"><span>👥 CO-OP · 2 players</span><button id="pmX">✕</button></div>' +
      '<div id="pmStatus">' + MP.status + '</div>' +
      '<div id="pmOut">' +
      '<div class="pm-row"><select id="pmWorld">' + opts + '</select></div>' +
      '<label><input type="checkbox" id="pmPub"> list in public lobby</label><br>' +
      '<button id="pmCreate">➕ Create room</button>' +
      '<div class="pm-row"><input type="text" id="pmCode" maxlength="4" placeholder="CODE" style="width:90px;text-transform:uppercase"><button id="pmJoin">Join</button></div>' +
      '<button id="pmList">🔎 Public rooms</button><div id="pmRooms"></div>' +
      '</div>' +
      '<div id="pmIn" style="display:none">' +
      '<div id="pmBig"></div>' +
      '<div id="pmWho"></div>' +
      '<button id="pmCopy">🔗 Copy link</button><button id="pmShare">📤 Share</button><br>' +
      '<button id="pmStart">▶ Start together</button><button id="pmLeave">🚪 Leave</button>' +
      '</div>' +
      '<div class="pm-soon">Coming next: QR code · direct phone-to-phone link</div>';
    document.body.appendChild(panel);

    // The game blocks touchstart on the document; stop it at the panel so taps and typing work.
    ['touchstart', 'touchmove', 'touchend', 'keydown', 'keyup', 'keypress'].forEach(function (ev) {
      panel.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true });
    });

    var $ = function (id) { return document.getElementById(id); };
    $('pmX').onclick = hidePanel;
    $('pmCreate').onclick = function () { MP.createRoom($('pmWorld').value, $('pmPub').checked); };
    $('pmJoin').onclick = function () { MP.joinRoom($('pmCode').value); };
    $('pmList').onclick = function () {
      $('pmRooms').textContent = 'Looking…';
      MP.listPublic().then(function (rooms) {
        var box = $('pmRooms'); box.textContent = '';
        if (!rooms.length) { box.textContent = 'No public rooms right now.'; return; }
        rooms.forEach(function (r) {
          var b = document.createElement('button');
          b.textContent = r.code + ' · ' + ((typeof WORLDS !== 'undefined' && WORLDS[r.world]) ? WORLDS[r.world].name : r.world);
          b.onclick = function () { MP.joinRoom(r.code); };
          box.appendChild(b);
        });
      });
    };
    $('pmCopy').onclick = function () { copyText(shareLink()); say('Link copied: ' + shareLink()); };
    $('pmShare').onclick = function () {
      if (navigator.share) navigator.share({ title: 'Pumpkin Guy co-op', text: 'Join my room ' + MP.code, url: shareLink() }).catch(function () {});
      else { copyText(shareLink()); say('Link copied: ' + shareLink()); }
    };
    $('pmStart').onclick = function () { MP.start(); };
    $('pmLeave').onclick = function () { MP.leave(); };
  }

  function shareLink() { return location.origin + location.pathname + '?room=' + MP.code; }
  function copyText(t) {
    try { if (navigator.clipboard) navigator.clipboard.writeText(t); } catch (e) { /* ignore */ }
  }

  function renderPanel() {
    if (!panel) return;
    var $ = function (id) { return document.getElementById(id); };
    var n = Object.keys(MP.slots || {}).length;
    $('pmOut').style.display = MP.active ? 'none' : 'block';
    $('pmIn').style.display = MP.active ? 'block' : 'none';
    if (MP.active) {
      $('pmBig').textContent = MP.code;
      $('pmWho').textContent = 'Players: ' + n + ' / ' + MAX_PLAYERS + (MP.isHost ? ' (you are the host)' : '');
      $('pmStart').style.display = (MP.isHost && n >= MAX_PLAYERS) ? 'inline-block' : 'none';
    }
    $('pmStatus').textContent = MP.status;
  }

  function addButtons() {
    var b = document.createElement('button');
    b.id = 'pkgMPBtn'; b.textContent = '👥 CO-OP';
    b.addEventListener('touchstart', function (e) { e.stopPropagation(); }, { passive: true });
    b.onclick = showPanel;
    document.body.appendChild(b);
    var pause = document.getElementById('pauseOv');
    if (pause) {
      var pb = document.createElement('button');
      pb.className = 'bb bg'; pb.style.marginTop = '8px'; pb.textContent = '👥 CO-OP';
      pb.onclick = showPanel;
      pause.appendChild(pb);
    }
  }

  // ---- boot -------------------------------------------------------
  function boot() {
    installWrappers();
    buildPanel();
    addButtons();
    requestAnimationFrame(loop);
    var m = /[?&]room=([A-Za-z0-9]{4})/.exec(location.search || '');
    if (m) { showPanel(); MP.joinRoom(m[1]); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
