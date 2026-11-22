'use strict';
// Lokale Konfiguration (config.json). Alles ES5, kein mkdir -p, keine neueren Node-APIs.
var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');

var DEFAULT_PORT = 8765;

function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

function isWritableDir(dir) {
  try {
    mkdirp(dir);
    var probe = path.join(dir, '.write-test-' + process.pid);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

// Erstes beschreibbares Verzeichnis: Umgebungsvariable, dann "data" neben dem Dienst (bleibt auf dem TV
// ueber Neustarts erhalten; im webOS-Jail ist nur der eigene Dienstordner beschreibbar), dann
// /media/developer, zuletzt das Temp-Verzeichnis.
function pickDataDir() {
  var candidates = [];
  if (process.env.SMBSTREAM_DATA) candidates.push(process.env.SMBSTREAM_DATA);
  candidates.push(path.join(__dirname, 'data'));
  candidates.push('/media/developer/smbstream');
  candidates.push(path.join(os.tmpdir(), 'smbstream'));
  for (var i = 0; i < candidates.length; i++) {
    if (isWritableDir(candidates[i])) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

var dataDir = pickDataDir();
var file = path.join(dataDir, 'config.json');

var data = { version: 1, port: DEFAULT_PORT, admin: null, autoResume: false, shares: [] };

function load() {
  try {
    var parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      data.port = parsed.port || DEFAULT_PORT;
      data.admin = parsed.admin || null;
      data.autoResume = parsed.autoResume === true;
      data.shares = Array.isArray(parsed.shares) ? parsed.shares : [];
    }
  } catch (e) {
    // Datei fehlt oder ist kaputt: mit leerer Konfiguration starten
  }
}

function save() {
  mkdirp(dataDir);
  var tmp = file + '.tmp';
  var json = JSON.stringify(data, null, 2);
  // Passwoerter stehen im Klartext in der Datei (der SMB-Login braucht sie): nur fuer den Besitzer lesbar
  fs.writeFileSync(tmp, json, { mode: parseInt('600', 8) });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, parseInt('600', 8)); } catch (e) { /* nicht kritisch */ }
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function str(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/^\s+|\s+$/g, '').substring(0, max || 255);
}

// Pruefen und bereinigen; wirft Error mit deutscher Meldung
function normalizeShare(input, existing) {
  var s = {
    id: existing ? existing.id : newId(),
    name: str(input.name, 80),
    host: str(input.host, 255),
    port: parseInt(input.port, 10) || 445,
    share: str(input.share, 255).replace(/^[\\\/]+|[\\\/]+$/g, ''),
    subpath: str(input.subpath, 1024).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
    username: str(input.username, 255),
    domain: str(input.domain, 255),
    password: existing ? existing.password : ''
  };
  if (input.password !== undefined && input.password !== null && input.password !== '') {
    s.password = String(input.password);
  }
  if (input.clearPassword === true) s.password = '';

  if (!s.host) throw new Error('Bitte einen Server (Name oder IP) angeben.');
  if (/[\\\/\s]/.test(s.host)) throw new Error('Der Servername darf keine Schraegstriche oder Leerzeichen enthalten.');
  if (!s.share) throw new Error('Bitte den Freigabenamen angeben.');
  if (s.port < 1 || s.port > 65535) throw new Error('Ungueltiger Port.');
  if (/(^|\/)\.\.(\/|$)/.test(s.subpath)) throw new Error('Der Unterordner darf kein ".." enthalten.');
  if (!s.name) s.name = s.host + ' / ' + s.share;
  return s;
}

function publicShare(s) {
  return {
    id: s.id, name: s.name, host: s.host, port: s.port, share: s.share,
    subpath: s.subpath, username: s.username, domain: s.domain,
    hasPassword: !!s.password
  };
}

function findShare(id) {
  for (var i = 0; i < data.shares.length; i++) {
    if (data.shares[i].id === id) return data.shares[i];
  }
  return null;
}

function saveShare(input) {
  var existing = input.id ? findShare(input.id) : null;
  if (input.id && !existing) throw new Error('Freigabe nicht gefunden.');
  var s = normalizeShare(input, existing);
  if (existing) {
    data.shares[data.shares.indexOf(existing)] = s;
  } else {
    data.shares.push(s);
  }
  save();
  return s;
}

function deleteShare(id) {
  var s = findShare(id);
  if (!s) return false;
  data.shares.splice(data.shares.indexOf(s), 1);
  save();
  return true;
}

// ---- Zugriffsschutz fuer die Weboberflaeche (optional) ----
function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}

function setAdminPassword(password) {
  if (!password) {
    data.admin = null;
  } else {
    var salt = crypto.randomBytes(8).toString('hex');
    data.admin = { salt: salt, hash: hashPassword(String(password), salt) };
  }
  save();
}

function checkAdminPassword(password) {
  if (!data.admin) return true;
  return hashPassword(String(password), data.admin.salt) === data.admin.hash;
}

load();

module.exports = {
  data: data,
  file: file,
  dataDir: dataDir,
  defaultPort: DEFAULT_PORT,
  load: load,
  save: save,
  findShare: findShare,
  saveShare: saveShare,
  deleteShare: deleteShare,
  publicShare: publicShare,
  setAdminPassword: setAdminPassword,
  checkAdminPassword: checkAdminPassword,
  hasAdminPassword: function () { return !!data.admin; },
  setAutoResume: function (on) { data.autoResume = !!on; save(); },
  normalizeShare: normalizeShare
};
