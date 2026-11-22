/* SMB Player – TV-App (webOS 4.x, Chromium 53: bewusst reines ES5). */
(function () {
  'use strict';

  var SERVICE_URI = 'luna://org.smbstream.app.service/';
  var DEFAULT_PORT = 8765;
  var MEDIA_EXT = /\.(mkv|mp4|m4v|mov|avi|ts|m2ts|mts|mpg|mpeg|wmv|webm|flv|3gp|vob|divx|mp3|flac|m4a|aac|ogg|wav)$/i;
  var ROWS = 10;               // sichtbare Listenzeilen (Zeilenhoehe 84 px)
  var MIN_RESUME = 15;         // erste Sekunden: nicht zum Fortsetzen merken
  var END_MARGIN = 30;         // letzte Sekunden: gilt als zu Ende gesehen

  var K = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 461, BACKSPACE: 8, ESC: 27,
    PLAY: 415, PAUSE: 19, STOP: 413, REW: 412, FF: 417, RED: 403, YELLOW: 405, CH_UP: 427, CH_DOWN: 428
  };

  var state = {
    screen: 'loading',
    base: 'http://127.0.0.1:' + DEFAULT_PORT,
    info: null,
    shares: [],
    share: null,
    mode: 'home',          // 'home' (Freigaben) oder 'dir' (Ordner einer Freigabe)
    path: '',              // Pfad innerhalb der Freigabe, Segmente mit "/"
    stack: [],             // gemerkte Fokuspositionen beim Eintauchen in Ordner
    playingIndex: -1,
    pos: {},               // shareId -> { pfad: { t, d } }  (Stand vom Dienst, lokal nachgefuehrt)
    last: null,            // zuletzt gespielte Datei { share, shareName, path, dir, name, t, d }
    autoResume: false,
    pendingPlay: null,     // { name, fromStart }: nach dem Laden des Ordners direkt abspielen
    messageAction: null,
    messageBack: null
  };

  function $(id) { return document.getElementById(id); }

  // ------------------------------------------------------------------ Hilfen

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h > 0 ? h + ':' + pad2(m) : m) + ':' + pad2(s);
  }

  function fmtClock() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtDate(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear();
  }

  function fmtSize(b) {
    if (b >= 1073741824) return (b / 1073741824).toFixed(1).replace('.', ',') + ' GB';
    if (b >= 1048576) return Math.round(b / 1048576) + ' MB';
    if (b >= 1024) return Math.round(b / 1024) + ' KB';
    return b + ' B';
  }

  function enc(s) { return encodeURIComponent(s); }
  function joinPath(dir, name) { return dir ? dir + '/' + name : name; }
  function parentPath(p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.substring(0, i); }
  function resumable(t, d) { return t >= MIN_RESUME && d > 0 && t <= d - END_MARGIN; }
  function pct(t, d) { return d > 0 ? Math.max(0, Math.min(100, Math.round(t / d * 100))) : 0; }

  function showScreen(name) {
    var all = ['Loading', 'Message', 'Browse', 'Player'];
    for (var i = 0; i < all.length; i++) $('screen' + all[i]).hidden = (all[i].toLowerCase() !== name);
    state.screen = name;
  }

  function exitApp() {
    try {
      if (window.PalmSystem && window.PalmSystem.platformBack) { window.PalmSystem.platformBack(); return; }
    } catch (e) { /* weiter */ }
    window.close();
  }

  function xhr(method, path, body, cb, timeoutMs) {
    var x = new XMLHttpRequest();
    var done = false;
    function finish(err, data) { if (done) return; done = true; if (cb) cb(err, data); }
    x.open(method, state.base + path, true);
    x.timeout = timeoutMs || 15000;
    x.onload = function () {
      var d = null;
      try { d = JSON.parse(x.responseText); } catch (e) { d = null; }
      if (x.status >= 200 && x.status < 300 && d) finish(null, d);
      else finish(new Error((d && d.error) || ('HTTP ' + x.status)), d);
    };
    x.onerror = function () { finish(new Error('Dienst nicht erreichbar')); };
    x.ontimeout = function () { finish(new Error('Zeitüberschreitung')); };
    if (body !== null && body !== undefined) {
      x.setRequestHeader('Content-Type', 'text/plain');   // text/plain: keine CORS-Vorabfrage noetig
      x.send(JSON.stringify(body));
    } else {
      x.send();
    }
  }

  function getJson(path, cb, timeoutMs) { xhr('GET', path, null, cb, timeoutMs); }
  function postJson(path, body, cb) { xhr('POST', path, body, cb, 8000); }

  function lunaCall(method, params, cb) {
    try {
      var bridge = new window.PalmServiceBridge();
      bridge.onservicecallback = function (msg) {
        var res;
        try { res = JSON.parse(msg); } catch (e) { res = { returnValue: false, errorText: 'Ungültige Antwort' }; }
        cb(res);
      };
      bridge.call(SERVICE_URI + method, JSON.stringify(params || {}));
    } catch (e) {
      cb({ returnValue: false, errorText: 'Luna-Dienstaufruf nicht möglich (' + (e && e.message) + ')' });
    }
  }

  var toastTimer = 0;
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }

  // ------------------------------------------------------------------ Uhr

  function tickClock() {
    var t = fmtClock();
    $('clock').textContent = t;
    $('osdClock').textContent = t;
  }
  setInterval(tickClock, 15000);
  tickClock();

  // ------------------------------------------------------------------ Virtuelle Liste
  // Feste Zeilenhoehe, nur ROWS Zeilen existieren im DOM. Bei tausenden Dateien bleibt das flott.

  function span(cls) {
    var e = document.createElement('span');
    e.className = cls;
    return e;
  }

  function VList(ul, rows, onChange, onActivate) {
    this.ul = ul;
    this.rows = rows;
    this.items = [];
    this.focus = 0;
    this.top = 0;
    this.lis = [];
    this.onChange = onChange;
    this.onActivate = onActivate;
    for (var i = 0; i < rows; i++) {
      var li = this.makeRow(i);
      ul.appendChild(li);
      this.lis.push(li);
    }
  }

  VList.prototype.makeRow = function (slot) {
    var self = this;
    var li = document.createElement('li');
    li._ico = span('ico');
    li._bar = span('pbar');
    li._fill = span('pfill');
    li._bar.appendChild(li._fill);
    var txt = document.createElement('div');
    txt.className = 'txt';
    li._name = span('name');
    li._sub = span('sub');
    txt.appendChild(li._name);
    txt.appendChild(li._sub);
    li._meta = span('meta');
    li.appendChild(li._ico);
    li.appendChild(li._bar);
    li.appendChild(txt);
    li.appendChild(li._meta);
    li._slot = slot;
    li.onclick = function () {
      var idx = self.top + li._slot;
      if (idx < self.items.length) { self.setFocus(idx); if (self.onActivate) self.onActivate(); }
    };
    return li;
  };

  VList.prototype.render = function () {
    for (var i = 0; i < this.rows; i++) {
      var li = this.lis[i];
      var idx = this.top + i;
      if (idx >= this.items.length) { li.style.display = 'none'; continue; }
      var it = this.items[idx];
      li.style.display = '';
      li.className = idx === this.focus ? 'focus' : '';
      li._ico.className = 'ico ' + it.kind;
      if (it.pct === undefined || it.pct === null) {
        li._bar.style.display = 'none';
      } else {
        li._bar.style.display = 'block';
        li._fill.style.width = it.pct + '%';
      }
      li._name.textContent = it.name;
      li._sub.textContent = it.sub || '';
      li._sub.style.display = it.sub ? 'block' : 'none';
      li._meta.textContent = it.meta || '';
    }
  };

  VList.prototype.setItems = function (items, focus) {
    this.items = items;
    this.focus = Math.max(0, Math.min(items.length - 1, focus || 0));
    this.top = Math.max(0, Math.min(items.length - this.rows, this.focus - Math.floor(this.rows / 2)));
    this.render();
    if (this.onChange) this.onChange(this.current());
  };

  VList.prototype.setFocus = function (idx) {
    if (!this.items.length) return;
    idx = Math.max(0, Math.min(this.items.length - 1, idx));
    if (idx < this.top) this.top = idx;
    else if (idx >= this.top + this.rows) this.top = idx - this.rows + 1;
    this.focus = idx;
    this.render();
    if (this.onChange) this.onChange(this.current());
  };

  VList.prototype.move = function (delta) { this.setFocus(this.focus + delta); };
  VList.prototype.current = function () { return this.items[this.focus] || null; };

  var list = new VList($('list'), ROWS, updateSide, function () { activate(); });

  // ------------------------------------------------------------------ Infofenster rechts

  function posOf(shareId, path) {
    var m = state.pos[shareId];
    return m ? m[path] : null;
  }

  function seenText(p) {
    return 'Zuletzt gesehen bei ' + fmtTime(p.t) + ' von ' + fmtTime(p.d) + '.';
  }

  function updateSide(item) {
    var ico = $('sideIco'), size = $('sideSize'), date = $('sideDate'), chan = $('sideChan');
    var title = $('sideTitle'), desc = $('sideDesc'), prog = $('sideProg');
    size.textContent = '';
    date.textContent = '';
    prog.hidden = true;
    if (!item) {
      ico.className = 'ico';
      chan.textContent = '';
      title.textContent = '';
      desc.textContent = '';
      return;
    }
    ico.className = 'ico ' + item.kind;
    var where = state.share ? state.share.name + ' · /' + state.path : '';
    var p = null;

    if (item.kind === 'resume') {
      p = item.last;
      chan.textContent = p.shareName + ' · /' + p.dir;
      title.textContent = p.name;
      desc.textContent = seenText(p) + '\n\nOK: Fortsetzen\nRot: Von vorn';
    } else if (item.kind === 'share') {
      var s = item.share;
      chan.textContent = '\\\\' + s.host + (s.port !== 445 ? ':' + s.port : '') + '\\' + s.share;
      title.textContent = s.name;
      desc.textContent = (s.username ? 'Benutzer: ' + s.username : 'Gast (ohne Anmeldung)') +
        (s.subpath ? '\nStartordner: /' + s.subpath : '');
    } else if (item.kind === 'dir') {
      chan.textContent = where;
      title.textContent = item.name;
      desc.textContent = 'Ordner';
    } else {
      chan.textContent = where;
      title.textContent = item.name;
      size.textContent = fmtSize(item.size);
      date.textContent = fmtDate(item.mtime);
      p = item.pos;
      desc.textContent = p ? seenText(p) + '\n\nOK: Fortsetzen\nRot: Von vorn' : 'Noch nicht gesehen.\n\nOK: Abspielen';
    }
    if (item.pct !== undefined && item.pct !== null) {
      prog.hidden = false;
      $('sideProgFill').style.width = item.pct + '%';
    }
  }

  // ------------------------------------------------------------------ Start

  function setLoading(text) { $('loadingText').textContent = text; showScreen('loading'); }

  function showMessage(title, text, hint, action, backAction) {
    $('msgTitle').textContent = title;
    $('msgText').textContent = text;
    $('msgHint').textContent = hint || '';
    state.messageAction = action || boot;
    state.messageBack = backAction || exitApp;
    showScreen('message');
  }

  function tryInfo(cb) {
    getJson('/api/info', function (err, info) {
      if (err) return cb(false);
      state.info = info;
      cb(true);
    }, 2500);
  }

  function pollInfo(n, lunaRes) {
    tryInfo(function (ok) {
      if (ok) return loadShares(true);
      if (n >= 25) {
        var detail = (lunaRes && lunaRes.errorText) ? lunaRes.errorText : 'keine Antwort vom Dienst';
        return showMessage('Dienst nicht erreichbar',
          'Der SMB-Dienst auf dem Fernseher läuft nicht.',
          'Details: ' + detail);
      }
      setTimeout(function () { pollInfo(n + 1, lunaRes); }, 800);
    });
  }

  function boot() {
    setLoading('Starte Dienst …');
    tryInfo(function (ok) {
      if (ok) return loadShares(true);
      lunaCall('start', {}, function (res) {
        if (res && res.port) state.base = 'http://127.0.0.1:' + res.port;
        pollInfo(0, res);
      });
    });
  }

  function configUrl() {
    var info = state.info || {};
    var ip = (info.ips && info.ips[0]) || 'IP-DES-FERNSEHERS';
    return 'http://' + ip + ':' + (info.port || DEFAULT_PORT) + '/';
  }

  function findShare(id) {
    for (var i = 0; i < state.shares.length; i++) if (state.shares[i].id === id) return state.shares[i];
    return null;
  }

  function lastResumable() {
    var l = state.last;
    return !!(l && resumable(l.t, l.d) && findShare(l.share));
  }

  // first = App-Start: dann wird bei aktivierter Einstellung automatisch fortgesetzt
  function loadShares(first) {
    setLoading('Lade Freigaben …');
    getJson('/api/shares', function (err, data) {
      if (err) return showMessage('Fehler', err.message, '', boot);
      state.shares = data.shares || [];
      if (state.shares.length === 0) {
        return showMessage('Noch keine Freigabe eingerichtet',
          'Öffne auf einem PC oder Handy im selben Netzwerk:',
          configUrl() + '   –   dort die SMB-Freigabe anlegen, danach hier OK drücken.',
          function () { loadShares(false); });
      }
      getJson('/api/last', function (e2, d2) {
        state.last = (!e2 && d2 && d2.last) ? d2.last : null;
        state.autoResume = !!(!e2 && d2 && d2.autoResume === true);
        if (first && state.autoResume && lastResumable()) return resumeLast(false);
        goHome();
      });
    });
  }

  // ------------------------------------------------------------------ Navigation

  function showList(items, focus) {
    list.setItems(items, focus);
    $('empty').hidden = items.length > 0;
  }

  function goHome() {
    state.mode = 'home';
    state.share = null;
    state.path = '';
    state.stack = [];
    var items = [];
    if (lastResumable()) {
      var l = state.last;
      items.push({
        kind: 'resume', name: 'Fortsetzen: ' + l.name,
        sub: l.shareName + (l.dir ? ' · /' + l.dir : ''),
        meta: fmtTime(l.t) + ' / ' + fmtTime(l.d), pct: pct(l.t, l.d), last: l
      });
    }
    for (var i = 0; i < state.shares.length; i++) {
      var s = state.shares[i];
      items.push({ kind: 'share', name: s.name, sub: '\\\\' + s.host + '\\' + s.share, share: s });
    }
    $('title').textContent = 'SMB Player';
    $('crumb').textContent = 'Freigaben';
    $('empty').textContent = '';
    $('foot').textContent = 'OK Öffnen   ·   Gelb Neu laden   ·   Einrichtung am PC: ' + configUrl();
    showList(items, 0);
    showScreen('browse');
  }

  function openShare(share) {
    state.mode = 'dir';
    state.share = share;
    state.path = '';
    state.stack = [];
    loadDir(0);
  }

  function dirItems(entries) {
    var out = [];
    var sid = state.share.id;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.isDir) {
        out.push({ kind: 'dir', name: e.name });
      } else if (MEDIA_EXT.test(e.name)) {
        var p = posOf(sid, joinPath(state.path, e.name));
        out.push({
          kind: 'file', name: e.name, size: e.size, mtime: e.mtime, meta: fmtSize(e.size),
          pos: p || null, pct: p ? pct(p.t, p.d) : null
        });
      }
    }
    return out;
  }

  function loadDir(focusIndex) {
    setLoading('Lade Ordner …');
    var sid = state.share.id;
    getJson('/api/browse?share=' + enc(sid) + '&path=' + enc(state.path), function (err, data) {
      if (err) {
        state.pendingPlay = null;
        return showMessage('Ordner konnte nicht geladen werden', err.message, state.share.name,
          function () { loadDir(focusIndex); },
          function () { goBack(); });
      }
      getJson('/api/positions?share=' + enc(sid), function (e2, d2) {
        if (!e2 && d2 && d2.positions) state.pos[sid] = d2.positions;
        buildDir(data.entries || [], focusIndex);
      });
    });
  }

  function buildDir(entries, focusIndex) {
    var items = dirItems(entries);
    state.mode = 'dir';
    $('title').textContent = state.share.name;
    $('crumb').textContent = '/' + state.path;
    $('empty').textContent = 'Keine Ordner oder Videos in diesem Ordner.';
    $('foot').textContent = 'OK Öffnen / Abspielen   ·   Rot Von vorn   ·   Zurück Eine Ebene höher';
    showList(items, focusIndex);

    var pp = state.pendingPlay;
    state.pendingPlay = null;
    if (pp) {
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && items[i].name === pp.name) {
          list.setFocus(i);
          return play(i, pp.fromStart);
        }
      }
      showScreen('browse');
      return toast('Die Datei ist nicht mehr vorhanden');
    }
    showScreen('browse');
  }

  // Zuletzt gespielte Datei fortsetzen: erst in ihren Ordner wechseln (damit "Zurueck" und die
  // naechste Folge sinnvoll funktionieren), dann abspielen.
  function resumeLast(fromStart) {
    var l = state.last;
    var share = l && findShare(l.share);
    if (!share) return goHome();
    state.mode = 'dir';
    state.share = share;
    state.path = l.dir;
    state.stack = [];
    var depth = l.dir ? l.dir.split('/').length : 0;
    for (var i = 0; i < depth; i++) state.stack.push(0);
    state.pendingPlay = { name: l.name, fromStart: !!fromStart };
    loadDir(0);
  }

  function activate() {
    var item = list.current();
    if (!item) return;
    if (item.kind === 'resume') {
      resumeLast(false);
    } else if (item.kind === 'share') {
      openShare(item.share);
    } else if (item.kind === 'dir') {
      state.stack.push(list.focus);
      state.path = joinPath(state.path, item.name);
      loadDir(0);
    } else {
      play(list.focus, false);
    }
  }

  function goBack() {
    if (state.mode === 'home' || !state.share) return exitApp();
    if (state.path === '') return goHome();
    state.path = parentPath(state.path);
    loadDir(state.stack.length ? state.stack.pop() : 0);
  }

  // ------------------------------------------------------------------ Wiedergabestand

  function setPosLocal(shareId, path, t, d) {
    var sh = findShare(shareId);
    if (!state.pos[shareId]) state.pos[shareId] = {};
    if (resumable(t, d)) {
      state.pos[shareId][path] = { t: t, d: d };
      var i = path.lastIndexOf('/');
      state.last = {
        share: shareId, shareName: sh ? sh.name : '', path: path,
        dir: i < 0 ? '' : path.substring(0, i), name: i < 0 ? path : path.substring(i + 1), t: t, d: d
      };
    } else {
      delete state.pos[shareId][path];
      if (state.last && state.last.share === shareId && state.last.path === path) state.last = null;
    }
  }

  // Frische Fortschrittsbalken nach der Wiedergabe
  function refreshItems() {
    if (state.mode !== 'dir' || !state.share) return;
    var items = list.items;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind !== 'file') continue;
      var p = posOf(state.share.id, joinPath(state.path, items[i].name));
      items[i].pos = p || null;
      items[i].pct = p ? pct(p.t, p.d) : null;
    }
    list.render();
    updateSide(list.current());
  }

  // ------------------------------------------------------------------ Player

  var video = $('video');
  var osdTimer = 0, seekTimer = 0, lastReport = 0;
  var seekTarget = null;
  var resumeTo = 0;
  var reportReady = false;      // erst melden, wenn die Wiedergabe an der Fortsetzungsstelle angekommen ist
  var cur = null;               // { path, name }

  function showOsd(sticky) {
    $('osd').hidden = false;
    tickClock();
    clearTimeout(osdTimer);
    if (!sticky && !video.paused) {
      osdTimer = setTimeout(function () { $('osd').hidden = true; }, 5000);
    }
  }

  function updateOsd() {
    if (!cur) return;
    var t = seekTarget !== null ? seekTarget : video.currentTime;
    var d = video.duration;
    var known = isFinite(d) && d > 0;
    $('osdState').className = video.paused ? 'pause' : 'play';
    $('osdNow').textContent = fmtTime(t) + ' / ' + fmtTime(d) +
      (known ? '   (noch ' + Math.max(0, Math.round((d - t) / 60)) + ' Min.)' : '');
    $('osdFill').style.width = (known ? Math.min(100, t / d * 100) : 0) + '%';
  }

  function nextFileIndex() {
    var items = list.items;
    for (var i = state.playingIndex + 1; i < items.length; i++) if (items[i].kind === 'file') return i;
    return -1;
  }

  function reportPosition() {
    if (!cur || !reportReady || !state.share) return;
    var t = Math.floor(video.currentTime), d = Math.floor(video.duration);
    if (!isFinite(t) || !isFinite(d) || d <= 0) return;
    var sid = state.share.id;
    if (resumable(t, d)) {
      setPosLocal(sid, cur.path, t, d);
      postJson('/api/position', { share: sid, path: cur.path, t: t, d: d });
    } else if (t > d - END_MARGIN) {
      setPosLocal(sid, cur.path, t, d);
      postJson('/api/position', { share: sid, path: cur.path, clear: true });
    }
  }

  function play(index, fromStart) {
    var item = list.items[index];
    if (!item || item.kind !== 'file') return;
    state.playingIndex = index;
    var path = joinPath(state.path, item.name);
    cur = { path: path, name: item.name };

    var pos = posOf(state.share.id, path);
    resumeTo = (!fromStart && pos && resumable(pos.t, pos.d)) ? pos.t : 0;
    seekTarget = null;
    reportReady = false;
    lastReport = 0;

    $('osdName').textContent = item.name;
    $('osdGroup').textContent = state.share.name + ' · /' + state.path;
    var nx = nextFileIndex();
    $('osdNext').textContent = nx >= 0 ? 'Danach  ' + list.items[nx].name : '';
    $('osdFill').style.width = '0';
    $('osdNow').textContent = '';
    $('toast').hidden = true;
    showScreen('player');
    $('buffering').hidden = false;
    showOsd(true);

    video.onloadedmetadata = function () {
      if (resumeTo > 0 && resumeTo < video.duration - END_MARGIN) {
        try { video.currentTime = resumeTo; } catch (e) { /* ignorieren */ }
        toast('Fortgesetzt bei ' + fmtTime(resumeTo) + '  ·  Rot: von vorn');
      } else {
        resumeTo = 0;
      }
      updateOsd();
    };
    video.onplaying = function () { $('buffering').hidden = true; showOsd(false); updateOsd(); };
    video.onwaiting = function () { $('buffering').hidden = false; };
    video.onseeked = function () { $('buffering').hidden = true; };
    video.onpause = function () { updateOsd(); showOsd(true); };
    video.ontimeupdate = function () {
      updateOsd();
      if (!reportReady && !video.seeking && video.currentTime >= Math.max(0, resumeTo - 2)) reportReady = true;
      var now = new Date().getTime();
      if (now - lastReport > 10000) { lastReport = now; reportPosition(); }
    };
    video.onended = function () { onEnded(); };
    video.onerror = function () { onVideoError(); };

    video.src = state.base + '/stream?share=' + enc(state.share.id) + '&path=' + enc(path);
    var p = video.play();
    if (p && p['catch']) p['catch'](function () { /* Fehler meldet das error-Event */ });
  }

  function stopVideo() {
    video.onloadedmetadata = video.onplaying = video.onwaiting = video.onseeked = null;
    video.onpause = video.ontimeupdate = video.onended = video.onerror = null;
    try { video.pause(); } catch (e) { /* ignorieren */ }
    video.removeAttribute('src');
    try { video.load(); } catch (e2) { /* ignorieren */ }
  }

  function backToList() {
    refreshItems();
    showScreen('browse');
  }

  function leavePlayer() {
    clearTimeout(osdTimer);
    clearTimeout(seekTimer);
    seekTarget = null;
    reportPosition();
    stopVideo();
    cur = null;
    backToList();
  }

  function onEnded() {
    // Zu Ende gesehen: nichts mehr zum Fortsetzen
    if (cur && state.share) {
      setPosLocal(state.share.id, cur.path, 0, 0);
      postJson('/api/position', { share: state.share.id, path: cur.path, clear: true });
    }
    // Naechste Datei im selben Ordner automatisch abspielen (z. B. Serienfolgen)
    var next = nextFileIndex();
    stopVideo();
    cur = null;
    if (next >= 0) {
      list.setFocus(next);
      play(next, false);
    } else {
      backToList();
    }
  }

  function onVideoError() {
    var code = video.error ? video.error.code : 0;
    var texts = {
      1: 'Wiedergabe abgebrochen.',
      2: 'Netzwerkfehler beim Lesen der Datei.',
      3: 'Die Datei konnte nicht dekodiert werden.',
      4: 'Dieses Format wird vom Fernseher nicht unterstützt.'
    };
    var name = cur ? cur.name : '';
    reportPosition();
    stopVideo();
    cur = null;
    var back = function () { backToList(); };
    showMessage('Wiedergabe nicht möglich', texts[code] || 'Unbekannter Fehler.', name, back, back);
  }

  function seekBy(delta) {
    if (!isFinite(video.duration)) return;
    var base = seekTarget !== null ? seekTarget : video.currentTime;
    seekTarget = Math.max(0, Math.min(video.duration - 1, base + delta));
    showOsd(false);
    updateOsd();
    clearTimeout(seekTimer);
    seekTimer = setTimeout(function () {
      try { video.currentTime = seekTarget; } catch (e) { /* ignorieren */ }
      seekTarget = null;
      $('buffering').hidden = false;
    }, 400);
  }

  function togglePlay() {
    if (video.paused) { var p = video.play(); if (p && p['catch']) p['catch'](function () {}); }
    else video.pause();
  }

  function playerKey(code) {
    switch (code) {
      case K.ENTER: togglePlay(); showOsd(video.paused); break;
      case K.PLAY: if (video.paused) togglePlay(); showOsd(video.paused); break;
      case K.PAUSE: if (!video.paused) togglePlay(); showOsd(video.paused); break;
      case K.LEFT: seekBy(-10); break;
      case K.RIGHT: seekBy(10); break;
      case K.DOWN: seekBy(-60); break;
      case K.UP: seekBy(60); break;
      case K.REW: seekBy(-30); break;
      case K.FF: seekBy(30); break;
      case K.RED:
        try { video.currentTime = 0; } catch (e) { /* ignorieren */ }
        showOsd(false);
        break;
      case K.STOP: case K.BACK: case K.BACKSPACE: case K.ESC:
        leavePlayer(); break;
      default:
        return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ Tasten

  function onKey(ev) {
    var code = ev.keyCode;
    var handled = true;

    if (state.screen === 'player') {
      handled = playerKey(code);
    } else if (state.screen === 'browse') {
      switch (code) {
        case K.UP: list.move(-1); break;
        case K.DOWN: list.move(1); break;
        case K.CH_UP: case K.LEFT: list.move(-ROWS + 1); break;
        case K.CH_DOWN: case K.RIGHT: list.move(ROWS - 1); break;
        case K.ENTER: activate(); break;
        case K.RED:
          var it = list.current();
          if (it && it.kind === 'resume') resumeLast(true);
          else if (it && it.kind === 'file') play(list.focus, true);
          break;
        case K.BACK: case K.BACKSPACE: case K.ESC: goBack(); break;
        case K.YELLOW:
          if (state.mode === 'home') loadShares(false);
          break;
        default: handled = false;
      }
    } else if (state.screen === 'message') {
      switch (code) {
        case K.ENTER: if (state.messageAction) state.messageAction(); break;
        case K.BACK: case K.BACKSPACE: case K.ESC: (state.messageBack || exitApp)(); break;
        default: handled = false;
      }
    } else {
      // Ladebildschirm: Zurueck beendet die App
      if (code === K.BACK || code === K.BACKSPACE || code === K.ESC) exitApp(); else handled = false;
    }

    if (handled) { ev.preventDefault(); ev.stopPropagation(); }
  }

  $('list').addEventListener('wheel', function (ev) {
    if (state.screen !== 'browse') return;
    list.move(ev.deltaY > 0 ? 1 : -1);
    ev.preventDefault();
  });

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.screen === 'player' && !video.paused) {
      video.pause();
      reportPosition();
    }
  });

  boot();
})();
