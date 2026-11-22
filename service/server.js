'use strict';
// HTTP-Server: Konfig-Weboberflaeche, JSON-API und Datei-Streaming (mit Range-Unterstuetzung).
// Laeuft entweder im webOS-Service (service.js) oder allein: node server.js
var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');
var url = require('url');

var config = require('./config');
var pool = require('./smbpool');
var playstate = require('./playstate');
var bytes = require('./lib/bytes');
var smbmod = require('./lib/smb2');
var Smb2Client = smbmod.Smb2Client;
var smbPath = smbmod.smbPath;

var VERSION = '1.0.0';
var WEB_DIR = path.join(__dirname, 'web');

var MIME = {
  '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.mts': 'video/mp2t',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.wmv': 'video/x-ms-wmv', '.webm': 'video/webm',
  '.flv': 'video/x-flv', '.3gp': 'video/3gpp', '.vob': 'video/mpeg', '.divx': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav'
};

var STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8']
};

var server = null;
var listeningPort = 0;

// Node 0.12 (webOS 4) raeumt externe Buffer erst nach ~190 MB auf. Auf dem TV (~860 MB RAM) ist das zu viel:
// Wenn der Prozess mit --expose-gc laeuft, stossen wir die Speicherbereinigung beim Streamen selbst an.
var GC_EVERY = 12 * 1024 * 1024;
var gcBytes = 0;

function countStreamed(n) {
  gcBytes += n;
  if (gcBytes >= GC_EVERY) {
    gcBytes = 0;
    if (typeof global.gc === 'function') global.gc();
  }
}

// ------------------------------------------------------------------ Hilfsfunktionen

function sendJson(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendError(res, code, message) {
  sendJson(res, code, { ok: false, error: message });
}

function isLoopback(req) {
  var a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// Mutierende Aufrufe nur vom eigenen Ursprung: schuetzt vor fremden Webseiten (CSRF)
function sameOrigin(req) {
  var origin = req.headers.origin;
  if (!origin) return true;
  var host = origin.replace(/^[a-z]+:\/\//i, '');
  return host === req.headers.host;
}

function checkAuth(req, res) {
  if (!config.hasAdminPassword() || isLoopback(req)) return true;
  var h = req.headers.authorization || '';
  if (/^basic /i.test(h)) {
    var dec = bytes.fromString(h.substring(6), 'base64').toString('utf8');
    var pw = dec.substring(dec.indexOf(':') + 1);
    if (config.checkAdminPassword(pw)) return true;
  }
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="SMB Player", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8'
  });
  res.end('Anmeldung erforderlich');
  return false;
}

function readJson(req, cb) {
  var parts = [];
  var size = 0;
  var failed = false;
  req.on('data', function (d) {
    size += d.length;
    if (size > 65536 && !failed) { failed = true; cb(new Error('Anfrage zu gross')); req.destroy(); return; }
    parts.push(d);
  });
  req.on('end', function () {
    if (failed) return;
    try {
      cb(null, JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'));
    } catch (e) {
      cb(new Error('Ungueltiges JSON'));
    }
  });
}

function localIps() {
  var out = [];
  var ifs = os.networkInterfaces();
  var name;
  for (name in ifs) {
    if (!ifs.hasOwnProperty(name)) continue;
    for (var i = 0; i < ifs[name].length; i++) {
      var a = ifs[name][i];
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function joinSharePath(share, p) {
  var base = share.subpath || '';
  var rel = smbPath(p || '');           // wirft bei ".."
  if (base && rel) return base + '/' + rel;
  return base || rel;
}

function errStatus(err) {
  if (!err) return 500;
  if (err.code === 'NOT_FOUND') return 404;
  if (err.code === 'ACCESS_DENIED' || err.code === 'LOGON_FAILURE') return 403;
  if (err.code === 'BAD_PATH' || err.code === 'IS_A_DIRECTORY' || err.code === 'NOT_A_DIRECTORY') return 400;
  return 502;
}

// ------------------------------------------------------------------ Handler

function handleInfo(req, res) {
  sendJson(res, 200, {
    ok: true,
    name: 'SMB Player',
    version: VERSION,
    node: process.version,
    platform: process.platform + '/' + process.arch,
    ips: localIps(),
    port: listeningPort,
    configFile: config.file,
    shareCount: config.data.shares.length,
    hasAdminPassword: config.hasAdminPassword(),
    autoResume: config.data.autoResume,
    playstateFile: playstate.file,
    historyCount: playstate.count()
  });
}

function handleShares(req, res, parts) {
  if (req.method === 'GET') {
    // Freigabeliste nicht fuer fremde Webseiten lesbar machen (nur eigene Oberflaeche oder die TV-App)
    if (!sameOrigin(req) && !isLoopback(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
    return sendJson(res, 200, { ok: true, shares: config.data.shares.map(config.publicShare) });
  }
  if (!sameOrigin(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');

  if (req.method === 'DELETE' && parts[2]) {
    var removed = config.deleteShare(parts[2]);
    if (removed) playstate.forgetShare(parts[2]);
    return sendJson(res, removed ? 200 : 404, { ok: removed });
  }
  if (req.method === 'POST') {
    return readJson(req, function (err, body) {
      if (err) return sendError(res, 400, err.message);
      try {
        var s = config.saveShare(body);
        sendJson(res, 200, { ok: true, share: config.publicShare(s) });
      } catch (e) {
        sendError(res, 400, e.message);
      }
    });
  }
  sendError(res, 405, 'Methode nicht erlaubt');
}

// Verbindung testen, ohne zu speichern. Fehlendes Passwort wird aus der gespeicherten Freigabe ergaenzt.
function handleTest(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Methode nicht erlaubt');
  if (!sameOrigin(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  readJson(req, function (err, body) {
    if (err) return sendError(res, 400, err.message);
    var existing = body.id ? config.findShare(body.id) : null;
    var share;
    try { share = config.normalizeShare(body, existing); } catch (e) { return sendError(res, 400, e.message); }

    var finished = false;
    var client = new Smb2Client({
      host: share.host, port: share.port, username: share.username,
      password: share.password, domain: share.domain, share: share.share
    });
    function done(code, obj) {
      if (finished) return;
      finished = true;
      client.close();
      sendJson(res, code, obj);
    }
    client.connect(function (cerr) {
      if (cerr) return done(200, { ok: false, error: cerr.message });
      var dirPath;
      try { dirPath = joinSharePath(share, ''); } catch (e2) { return done(200, { ok: false, error: e2.message }); }
      client.readdir(dirPath, function (derr, entries) {
        if (derr) return done(200, { ok: false, error: derr.message });
        var dirs = 0;
        for (var i = 0; i < entries.length; i++) if (entries[i].isDir) dirs++;
        done(200, {
          ok: true,
          message: 'Verbindung erfolgreich: ' + dirs + ' Ordner und ' + (entries.length - dirs) + ' Dateien gefunden.',
          dialect: '0x' + client.dialect.toString(16),
          signing: client.signing
        });
      });
    });
  });
}

function handleAdmin(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Methode nicht erlaubt');
  if (!sameOrigin(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  readJson(req, function (err, body) {
    if (err) return sendError(res, 400, err.message);
    config.setAdminPassword(body.password || '');
    sendJson(res, 200, { ok: true, hasAdminPassword: config.hasAdminPassword() });
  });
}

// ---- Wiedergabestand (zuletzt gespielt / Position pro Datei) ----

// Schreibende Aufrufe: eigene Weboberflaeche (gleicher Ursprung) oder die TV-App (Loopback)
function localOrSameOrigin(req) {
  return sameOrigin(req) || isLoopback(req);
}

function lastInfo() {
  var l = playstate.getLast();
  if (!l) return null;
  var share = config.findShare(l.share);
  if (!share) return null;
  var i = l.path.lastIndexOf('/');
  return {
    share: l.share,
    shareName: share.name,
    path: l.path,
    dir: i < 0 ? '' : l.path.substring(0, i),
    name: i < 0 ? l.path : l.path.substring(i + 1),
    t: l.t,
    d: l.d,
    ts: l.ts
  };
}

function handleLast(req, res) {
  if (!localOrSameOrigin(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  sendJson(res, 200, { ok: true, autoResume: config.data.autoResume, last: lastInfo() });
}

function handlePositions(req, res, query) {
  if (!localOrSameOrigin(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  if (!config.findShare(query.share)) return sendError(res, 404, 'Freigabe nicht gefunden');
  sendJson(res, 200, { ok: true, positions: playstate.positionsFor(query.share) });
}

function handlePosition(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Methode nicht erlaubt');
  if (!localOrSameOrigin(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  readJson(req, function (err, body) {
    if (err) return sendError(res, 400, err.message);
    if (!config.findShare(body.share) || typeof body.path !== 'string' || !body.path) {
      return sendError(res, 400, 'Freigabe oder Pfad fehlt');
    }
    if (body.clear === true) playstate.clearPosition(body.share, body.path);
    else playstate.setPosition(body.share, body.path, body.t, body.d);
    sendJson(res, 200, { ok: true });
  });
}

function handleHistory(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Methode nicht erlaubt');
  if (!localOrSameOrigin(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  readJson(req, function (err, body) {
    if (err) return sendError(res, 400, err.message);
    if (body.clear !== 'all') return sendError(res, 400, 'Unbekannte Aktion');
    playstate.clearAll();
    sendJson(res, 200, { ok: true });
  });
}

function handleSettings(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Methode nicht erlaubt');
  if (!sameOrigin(req)) return sendError(res, 403, 'Fremder Ursprung nicht erlaubt');
  readJson(req, function (err, body) {
    if (err) return sendError(res, 400, err.message);
    if (body.autoResume !== undefined) config.setAutoResume(body.autoResume === true);
    sendJson(res, 200, { ok: true, autoResume: config.data.autoResume });
  });
}

function handleBrowse(req, res, query) {
  var share = config.findShare(query.share);
  if (!share) return sendError(res, 404, 'Freigabe nicht gefunden');
  var p;
  try { p = joinSharePath(share, query.path || ''); } catch (e) { return sendError(res, 400, e.message); }

  pool.run(share, function (client, done) { client.readdir(p, done); }, function (err, entries) {
    if (err) return sendError(res, errStatus(err), err.message);
    entries.sort(function (a, b) {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      var x = a.name.toLowerCase(), y = b.name.toLowerCase();
      return x < y ? -1 : (x > y ? 1 : 0);
    });
    sendJson(res, 200, { ok: true, path: query.path || '', entries: entries });
  });
}

function parseRange(header, size) {
  // Rueckgabe: null = kein Range, false = nicht erfuellbar, sonst {start,end}
  if (!header) return null;
  var m = /^bytes=(\d*)-(\d*)$/.exec(String(header).replace(/\s+/g, ''));
  if (!m || (m[1] === '' && m[2] === '')) return null;   // ungueltig/mehrere Bereiche: ganze Datei
  var start, end;
  if (m[1] === '') {
    var n = parseInt(m[2], 10);
    if (!n) return false;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start >= size || start > end) return false;
  return { start: start, end: end };
}

function handleStream(req, res, query) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Methode nicht erlaubt');
  var share = config.findShare(query.share);
  if (!share) return sendError(res, 404, 'Freigabe nicht gefunden');
  var p;
  try { p = joinSharePath(share, query.path || ''); } catch (e) { return sendError(res, 400, e.message); }
  if (!p) return sendError(res, 400, 'Kein Dateipfad');

  var aborted = false;
  var file = null;
  var stream = null;
  function cleanup() {
    aborted = true;
    if (stream) stream.abort();
    if (file) { var f = file; file = null; f.close(); }
  }
  res.on('close', cleanup);
  res.on('finish', cleanup);   // aelteres Node feuert 'close' nicht bei normalem Ende

  pool.run(share, function (client, done) { client.openFile(p, done); }, function (err, f) {
    if (err) return sendError(res, errStatus(err), err.message);
    if (aborted) { f.close(); return; }
    file = f;

    var ext = path.extname(p).toLowerCase();
    var headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache'
    };
    if (f.mtime) headers['Last-Modified'] = new Date(f.mtime).toUTCString();

    var range = parseRange(req.headers.range, f.size);
    if (range === false) {
      headers['Content-Range'] = 'bytes */' + f.size;
      res.writeHead(416, headers);
      res.end();
      return;
    }
    var start = 0, end = f.size - 1, code = 200;
    if (range) {
      start = range.start; end = range.end; code = 206;
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + f.size;
    }
    var length = f.size === 0 ? 0 : end - start + 1;
    headers['Content-Length'] = length;
    res.writeHead(code, headers);

    if (req.method === 'HEAD' || length === 0) { res.end(); return; }

    stream = f.stream(start, end);
    stream.on('data', function (d) { countStreamed(d.length); });
    stream.on('error', function () {
      // Mitten im Transfer: Verbindung hart beenden, damit der Player neu anfragt
      cleanup();
      res.destroy();
    });
    stream.pipe(res);
  });
}

function handleStatic(req, res, pathname) {
  var entry = STATIC[pathname];
  if (!entry) return sendError(res, 404, 'Nicht gefunden');
  fs.readFile(path.join(WEB_DIR, entry[0]), function (err, data) {
    if (err) return sendError(res, 404, 'Nicht gefunden');
    res.writeHead(200, { 'Content-Type': entry[1], 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function route(req, res) {
  var u = url.parse(req.url, true);
  var pathname = u.pathname || '/';
  var parts = pathname.split('/');            // ['', 'api', 'shares', 'id']

  // Lesende Endpunkte duerfen von der TV-App (anderer Ursprung) aufgerufen werden
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (!checkAuth(req, res)) return;

  try {
    if (pathname === '/stream') return handleStream(req, res, u.query);
    if (pathname === '/api/info' || pathname === '/api/ping') return handleInfo(req, res);
    if (pathname === '/api/browse') return handleBrowse(req, res, u.query);
    if (pathname === '/api/last') return handleLast(req, res);
    if (pathname === '/api/positions') return handlePositions(req, res, u.query);
    if (pathname === '/api/position') return handlePosition(req, res);
    if (pathname === '/api/settings') return handleSettings(req, res);
    if (pathname === '/api/history') return handleHistory(req, res);
    if (parts[1] === 'api' && parts[2] === 'shares') return handleShares(req, res, [parts[1], parts[2], parts[3] && decodeURIComponent(parts[3])]);
    if (pathname === '/api/test') return handleTest(req, res);
    if (pathname === '/api/admin') return handleAdmin(req, res);
    return handleStatic(req, res, pathname);
  } catch (e) {
    console.error('Fehler bei', req.url, e && e.stack || e);
    if (!res.headersSent) sendError(res, 500, 'Interner Fehler');
    else res.destroy();
  }
}

// ------------------------------------------------------------------ Start/Stop

function start(cb) {
  cb = cb || function () {};
  if (server) return cb(null, listeningPort);
  var s = http.createServer(route);
  s.timeout = 0;
  s.on('error', function (err) {
    if (server === s) server = null;
    cb(err);
  });
  s.listen(config.data.port, '0.0.0.0', function () {
    server = s;
    listeningPort = s.address().port;
    cb(null, listeningPort);
  });
}

function stop(cb) {
  pool.closeAll();
  if (!server) return cb && cb();
  var s = server;
  server = null;
  s.close(function () { if (cb) cb(); });
}

module.exports = {
  start: start,
  stop: stop,
  isRunning: function () { return !!server; },
  getPort: function () { return listeningPort; },
  version: VERSION
};

if (require.main === module) {
  start(function (err, port) {
    if (err) {
      console.error('Start fehlgeschlagen: ' + err.message);
      process.exit(1);
    }
    // Als Kindprozess des webOS-Service: beenden, sobald der Elternprozess weg ist (stdin wird geschlossen)
    if (process.env.SMBSTREAM_CHILD === '1') {
      process.stdin.resume();
      process.stdin.on('end', function () { stop(function () { process.exit(0); }); });
      process.stdin.on('close', function () { process.exit(0); });
    }
    console.log('SMB Player laeuft auf Port ' + port + ' (Node ' + process.version + ', gc ' + (typeof global.gc === 'function' ? 'an' : 'aus') + ')');
    console.log('Konfiguration: ' + config.file);
    var ips = localIps();
    for (var i = 0; i < ips.length; i++) console.log('  http://' + ips[i] + ':' + port + '/');
  });
  process.on('SIGTERM', function () { stop(function () { process.exit(0); }); });
  process.on('SIGINT', function () { stop(function () { process.exit(0); }); });
}
