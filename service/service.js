'use strict';
// webOS-Service: startet den HTTP-Server und haelt den Prozess am Leben.
// Luna-Aufrufe aus der App: luna://org.smbstream.app.service/start  und  /status
//
// Der Server laeuft in einem Kindprozess mit --expose-gc: Node 0.12 (webOS 4) raeumt Netzwerk-Buffer
// sonst erst nach ~190 MB auf, der TV hat aber nur ~860 MB RAM. Schlaegt das fehl, laeuft der Server
// im selben Prozess weiter (dann ohne gezielte Speicherbereinigung).
var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');
var pkgInfo = require('./package.json');
var config = require('./config');
var server = require('./server');

var Service = null;
try {
  Service = require('webos-service');
} catch (e) {
  Service = null;   // ausserhalb von webOS: Server laeuft trotzdem
}

var child = null;
var childStartedAt = 0;
var inProcess = false;   // Server laeuft im eigenen Prozess (Fallback)
var external = false;    // Port war schon belegt: ein anderer Prozess (z. B. Startskript) liefert aus

function running() {
  return !!child || inProcess || external;
}

function info() {
  return {
    running: running(),
    mode: child ? 'child' : (inProcess ? 'in-process' : (external ? 'external' : 'stopped')),
    port: server.getPort() || config.data.port,
    node: process.version,
    version: server.version,
    configFile: config.file
  };
}

function startInProcess(cb) {
  server.start(function (err) {
    if (err && err.code === 'EADDRINUSE') {
      external = true;        // laeuft schon anderswo: auch gut
      return cb(null);
    }
    if (!err) inProcess = true;
    cb(err);
  });
}

function startChild(cb) {
  var logFd = null;
  try {
    logFd = fs.openSync(path.join(config.dataDir, 'server.log'), 'a');
  } catch (e) {
    logFd = 'ignore';
  }

  var env = {};
  var k;
  for (k in process.env) if (process.env.hasOwnProperty(k)) env[k] = process.env[k];
  env.SMBSTREAM_CHILD = '1';

  var p;
  try {
    p = childProcess.spawn(process.execPath, ['--expose-gc', path.join(__dirname, 'server.js')], {
      env: env,
      stdio: ['pipe', logFd, logFd]
    });
  } catch (e2) {
    return cb(e2);
  }
  if (typeof logFd === 'number') { try { fs.closeSync(logFd); } catch (e3) { /* ignorieren */ } }

  child = p;
  childStartedAt = new Date().getTime();
  var answered = false;
  function answer(err) { if (!answered) { answered = true; cb(err); } }

  p.on('error', function (err) {
    child = null;
    answer(err);
  });
  p.on('exit', function () {
    var quick = new Date().getTime() - childStartedAt < 4000;
    child = null;
    if (quick) answer(new Error('Kindprozess sofort beendet'));
  });
  // Nach kurzer Zeit gilt der Kindprozess als gestartet
  setTimeout(function () { if (child === p) answer(null); }, 1500);
}

function start(cb) {
  if (running()) return cb(null);
  startChild(function (err) {
    if (!err) return cb(null);
    // Kind-Start fehlgeschlagen oder Port belegt: im eigenen Prozess versuchen
    startInProcess(cb);
  });
}

start(function (err) {
  if (err) console.error('Server konnte nicht gestartet werden: ' + err.message);
});

if (Service) {
  var service = new Service(pkgInfo.name);

  // Ohne Aktivitaet beendet webOS den Service nach wenigen Sekunden Leerlauf.
  var keepAlive = null;
  service.activityManager.create('smbstream-keepalive', function (activity) {
    keepAlive = activity;
  });

  service.register('start', function (message) {
    start(function (err) {
      var res = info();
      res.returnValue = !err;
      if (err) res.errorText = err.message;
      message.respond(res);
    });
  });

  service.register('status', function (message) {
    var res = info();
    res.returnValue = true;
    message.respond(res);
  });
}

process.on('exit', function () {
  if (child) { try { child.kill(); } catch (e) { /* ignorieren */ } }
});
