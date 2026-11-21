/* SMB Player – TV-App (webOS 4.x, Chromium 53: bewusst reines ES5). */
(function () {
  'use strict';

  var SERVICE_URI = 'luna://org.smbstream.app.service/';
  var DEFAULT_PORT = 8765;
  var MEDIA_EXT = /\.(mkv|mp4|m4v|mov|avi|ts|m2ts|mts|mpg|mpeg|wmv|webm|flv|3gp|vob|divx|mp3|flac|m4a|aac|ogg|wav)$/i;

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
    path: '',            // Pfad innerhalb der Freigabe, Segmente mit "/"
    entries: [],         // aktuelle Eintraege (nur Ordner und abspielbare Dateien)
    items: [],           // dargestellte Zeilen
    focus: 0,
    stack: [],           // gemerkte Fokuspositionen beim Eintauchen in Ordner
    playingIndex: -1,
    messageAction: null,
    messageBack: null
  };

  function $(id) { return document.getElementById(id); }

  // ------------------------------------------------------------------ Hilfen

  function store(key, value) {
    try {
      if (value === undefined) { var v = window.localStorage.getItem(key); return v === null ? null : v; }
      if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value);
    } catch (e) { /* localStorage nicht verfuegbar */ }
    return null;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h > 0 ? h + ':' + pad2(m) : m) + ':' + pad2(s);
  }

  function fmtSize(b) {
    if (b >= 1073741824) return (b / 1073741824).toFixed(1).replace('.', ',') + ' GB';
    if (b >= 1048576) return Math.round(b / 1048576) + ' MB';
    if (b >= 1024) return Math.round(b / 1024) + ' KB';
    return b + ' B';
  }

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

  function getJson(url, cb, timeoutMs) {
    var x = new XMLHttpRequest();
    var done = false;
    function finish(err, data) { if (done) return; done = true; cb(err, data); }
    x.open('GET', url, true);
    x.timeout = timeoutMs || 15000;
    x.onload = function () {
      var d = null;
      try { d = JSON.parse(x.responseText); } catch (e) { d = null; }
      if (x.status >= 200 && x.status < 300 && d) finish(null, d);
      else finish(new Error((d && d.error) || ('HTTP ' + x.status)), d);
    };
    x.onerror = function () { finish(new Error('Dienst nicht erreichbar')); };
    x.ontimeout = function () { finish(new Error('Zeitüberschreitung')); };
    x.send();
  }

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
    getJson(state.base + '/api/info', function (err, info) {
      if (err) return cb(false);
      state.info = info;
      cb(true);
    }, 2500);
  }

  function pollInfo(n, lunaRes) {
    tryInfo(function (ok) {
      if (ok) return loadShares();
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
      if (ok) return loadShares();
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

  function loadShares() {
    setLoading('Lade Freigaben …');
    getJson(state.base + '/api/shares', function (err, data) {
      if (err) return showMessage('Fehler', err.message, '', boot);
      state.shares = data.shares || [];
      if (state.shares.length === 0) {
        return showMessage('Noch keine Freigabe eingerichtet',
          'Öffne auf einem PC oder Handy im selben Netzwerk:',
          configUrl() + '   –   dort die SMB-Freigabe anlegen, danach hier OK drücken.',
          loadShares);
      }
      goHome();
    });
  }

  // ------------------------------------------------------------------ Liste

  function renderList() {
    var ul = $('list');
    ul.textContent = '';
    var items = state.items;
    for (var i = 0; i < items.length; i++) {
      ul.appendChild(buildRow(items[i], i));
    }
    $('empty').hidden = items.length > 0;
    setFocus(state.focus, true);
  }

  function buildRow(item, index) {
    var li = document.createElement('li');
    var ico = document.createElement('span');
    ico.className = 'ico ' + item.kind;
    li.appendChild(ico);
    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    li.appendChild(name);
    if (item.sub) {
      var sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = item.sub;
      li.appendChild(sub);
    }
    if (item.meta) {
      var meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = item.meta;
      li.appendChild(meta);
    }
    li.onclick = function () { setFocus(index); activate(); };
    return li;
  }

  function setFocus(index, noScroll) {
    var ul = $('list');
    var rows = ul.children;
    if (!rows.length) return;
    index = Math.max(0, Math.min(rows.length - 1, index));
    if (rows[state.focus]) rows[state.focus].className = '';
    state.focus = index;
    var row = rows[index];
    row.className = 'focus';
    if (noScroll === true && index === 0) { ul.scrollTop = 0; return; }
    var top = row.offsetTop;
    var h = row.offsetHeight;
    if (top < ul.scrollTop + 8) ul.scrollTop = Math.max(0, top - 8);
    else if (top + h > ul.scrollTop + ul.clientHeight - 8) ul.scrollTop = top + h - ul.clientHeight + 8;
  }

  function goHome() {
    state.share = null;
    state.path = '';
    state.stack = [];
    state.entries = [];
    state.items = state.shares.map(function (s) {
      return { kind: 'share', name: s.name, sub: '\\\\' + s.host + '\\' + s.share, share: s };
    });
    $('title').textContent = 'SMB Player';
    $('crumb').textContent = 'Freigaben';
    $('empty').textContent = '';
    $('foot').textContent = 'Einrichtung am PC/Handy: ' + configUrl() + '     ·     Gelb: Neu laden';
    state.focus = 0;
    showScreen('browse');
    renderList();
  }

  function openShare(share) {
    state.share = share;
    state.path = '';
    state.stack = [];
    loadDir(0);
  }

  function loadDir(focusIndex) {
    setLoading('Lade Ordner …');
    var url = state.base + '/api/browse?share=' + encodeURIComponent(state.share.id) +
      '&path=' + encodeURIComponent(state.path);
    getJson(url, function (err, data) {
      if (err) {
        return showMessage('Ordner konnte nicht geladen werden', err.message, state.share.name,
          function () { loadDir(focusIndex); },
          function () { goBack(); });
      }
      var out = [];
      var all = data.entries || [];
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        if (e.isDir) out.push({ kind: 'dir', name: e.name });
        else if (MEDIA_EXT.test(e.name)) out.push({ kind: 'file', name: e.name, meta: fmtSize(e.size), size: e.size });
      }
      state.items = out;
      state.entries = out;
      $('title').textContent = state.share.name;
      $('crumb').textContent = '/' + state.path;
      $('empty').textContent = 'Keine Ordner oder Videos in diesem Ordner.';
      $('foot').textContent = 'OK: Öffnen / Abspielen     ·     Zurück: Eine Ebene höher';
      state.focus = focusIndex || 0;
      showScreen('browse');
      renderList();
    });
  }

  function joinPath(dir, name) { return dir ? dir + '/' + name : name; }

  function parentPath(p) {
    var i = p.lastIndexOf('/');
    return i < 0 ? '' : p.substring(0, i);
  }

  function activate() {
    var item = state.items[state.focus];
    if (!item) return;
    if (item.kind === 'share') {
      openShare(item.share);
    } else if (item.kind === 'dir') {
      state.stack.push(state.focus);
      state.path = joinPath(state.path, item.name);
      loadDir(0);
    } else {
      play(state.focus);
    }
  }

  function goBack() {
    if (!state.share) return exitApp();
    if (state.path === '') return goHome();
    state.path = parentPath(state.path);
    loadDir(state.stack.length ? state.stack.pop() : 0);
  }

  // ------------------------------------------------------------------ Player

  var video = null;
  var osdTimer = null, toastTimer = null, seekTimer = null, saveTimer = 0;
  var seekTarget = null;
  var resumeTo = 0;
  var currentKey = '';
  var currentName = '';

  function posKey(path) { return 'pos:' + state.share.id + ':' + path; }

  function savePosition() {
    if (!video || !currentKey) return;
    var t = video.currentTime, d = video.duration;
    if (!isFinite(t) || !isFinite(d) || d <= 0) return;
    if (t < 15 || t > d - 30) store(currentKey, null);
    else store(currentKey, JSON.stringify({ t: Math.floor(t), d: Math.floor(d) }));
  }

  function showOsd(sticky) {
    $('osd').hidden = false;
    clearTimeout(osdTimer);
    if (!sticky && video && !video.paused) {
      osdTimer = setTimeout(function () { $('osd').hidden = true; }, 4000);
    }
  }

  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }

  function updateOsd() {
    if (!video) return;
    var cur = seekTarget !== null ? seekTarget : video.currentTime;
    var dur = video.duration;
    $('osdTime').textContent = fmtTime(cur) + ' / ' + fmtTime(dur);
    $('osdFill').style.width = (isFinite(dur) && dur > 0 ? Math.min(100, cur / dur * 100) : 0) + '%';
    $('osdState').textContent = video.paused ? '❚❚  Pause' : '▶';
  }

  function play(index) {
    var item = state.items[index];
    if (!item || item.kind !== 'file') return;
    state.playingIndex = index;
    video = $('video');
    var path = joinPath(state.path, item.name);
    currentKey = posKey(path);
    currentName = item.name;
    resumeTo = 0;
    seekTarget = null;

    var saved = null;
    try { saved = JSON.parse(store(currentKey) || 'null'); } catch (e) { saved = null; }
    if (saved && saved.t > 15) resumeTo = saved.t;

    $('osdTitle').textContent = item.name;
    $('toast').hidden = true;
    showScreen('player');
    $('buffering').hidden = false;
    showOsd(true);

    video.onloadedmetadata = function () {
      if (resumeTo > 0 && resumeTo < video.duration - 30) {
        try { video.currentTime = resumeTo; } catch (e) { /* ignorieren */ }
        toast('Fortgesetzt bei ' + fmtTime(resumeTo) + '  ·  Rot: von vorn');
      }
      updateOsd();
    };
    video.onplaying = function () { $('buffering').hidden = true; showOsd(false); updateOsd(); };
    video.onwaiting = function () { $('buffering').hidden = false; };
    video.onseeked = function () { $('buffering').hidden = true; };
    video.onpause = function () { updateOsd(); showOsd(true); };
    video.ontimeupdate = function () {
      updateOsd();
      var now = new Date().getTime();
      if (now - saveTimer > 5000) { saveTimer = now; savePosition(); }
    };
    video.onended = function () { onEnded(); };
    video.onerror = function () { onVideoError(); };

    video.src = state.base + '/stream?share=' + encodeURIComponent(state.share.id) +
      '&path=' + encodeURIComponent(path);
    var p = video.play();
    if (p && p['catch']) p['catch'](function () { /* Fehler meldet das error-Event */ });
  }

  function stopVideo() {
    if (!video) return;
    video.onloadedmetadata = video.onplaying = video.onwaiting = video.onseeked = null;
    video.onpause = video.ontimeupdate = video.onended = video.onerror = null;
    try { video.pause(); } catch (e) { /* ignorieren */ }
    video.removeAttribute('src');
    try { video.load(); } catch (e2) { /* ignorieren */ }
  }

  function leavePlayer() {
    clearTimeout(osdTimer);
    clearTimeout(seekTimer);
    seekTarget = null;
    savePosition();
    stopVideo();
    showScreen('browse');
    renderList();
  }

  function onEnded() {
    store(currentKey, null);
    // Naechste Datei im selben Ordner automatisch abspielen (z. B. Serienfolgen)
    var next = -1;
    for (var i = state.playingIndex + 1; i < state.items.length; i++) {
      if (state.items[i].kind === 'file') { next = i; break; }
    }
    stopVideo();
    if (next >= 0) {
      state.focus = next;
      play(next);
    } else {
      showScreen('browse');
      renderList();
    }
  }

  function onVideoError() {
    var code = video && video.error ? video.error.code : 0;
    var texts = {
      1: 'Wiedergabe abgebrochen.',
      2: 'Netzwerkfehler beim Lesen der Datei.',
      3: 'Die Datei konnte nicht dekodiert werden.',
      4: 'Dieses Format wird vom Fernseher nicht unterstützt.'
    };
    savePosition();
    stopVideo();
    var backToList = function () { showScreen('browse'); renderList(); };
    showMessage('Wiedergabe nicht möglich', texts[code] || 'Unbekannter Fehler.', currentName,
      backToList, backToList);
  }

  function seekBy(delta) {
    if (!video || !isFinite(video.duration)) return;
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
    if (!video) return;
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
        store(currentKey, null);
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
        case K.UP: setFocus(state.focus - 1); break;
        case K.DOWN: setFocus(state.focus + 1); break;
        case K.CH_UP: setFocus(state.focus - 8); break;
        case K.CH_DOWN: setFocus(state.focus + 8); break;
        case K.ENTER: activate(); break;
        case K.BACK: case K.BACKSPACE: case K.ESC: goBack(); break;
        case K.YELLOW:
          if (!state.share) loadShares();
          break;
        default: handled = false;
      }
    } else if (state.screen === 'message') {
      switch (code) {
        case K.ENTER: if (state.messageAction) state.messageAction(); break;
        case K.BACK: case K.BACKSPACE: case K.ESC:
          (state.messageBack || exitApp)();
          break;
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
    setFocus(state.focus + (ev.deltaY > 0 ? 1 : -1));
    ev.preventDefault();
  });

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.screen === 'player' && video && !video.paused) {
      video.pause();
      savePosition();
    }
  });

  boot();
})();
