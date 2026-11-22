'use strict';
// Wiedergabestand: zuletzt gespielte Datei und Position pro Datei (playstate.json im Datenverzeichnis).
// Liegt bewusst getrennt von config.json: wird oft geschrieben und enthaelt keine Passwoerter.
var fs = require('fs');
var path = require('path');
var config = require('./config');

var file = path.join(config.dataDir, 'playstate.json');
var MAX_ENTRIES = 400;          // aelteste Positionen fallen heraus
var MIN_RESUME = 15;            // erste Sekunden: nicht merken
var END_MARGIN = 30;            // letzte Sekunden: gilt als zu Ende gesehen

var data = { last: null, positions: {} };   // positions[shareId][pfad] = { t, d, ts }
var saveTimer = null;

function load() {
  try {
    var p = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (p && typeof p === 'object') {
      data.last = p.last || null;
      data.positions = p.positions || {};
    }
  } catch (e) {
    // Datei fehlt oder ist kaputt: leer starten
  }
}

function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    var tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch (e) {
    // Datenverzeichnis nicht beschreibbar: Stand geht dann nur beim Neustart verloren
  }
}

// Schreiben zusammenfassen: Die App meldet die Position alle paar Sekunden
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 2000);
}

function resumable(t, d) {
  return t >= MIN_RESUME && d > 0 && t <= d - END_MARGIN;
}

function count() {
  var n = 0, s, p;
  for (s in data.positions) {
    if (!data.positions.hasOwnProperty(s)) continue;
    for (p in data.positions[s]) if (data.positions[s].hasOwnProperty(p)) n++;
  }
  return n;
}

function prune() {
  var n = count();
  while (n > MAX_ENTRIES) {
    var oldest = null, os = null, op = null, s, p;
    for (s in data.positions) {
      if (!data.positions.hasOwnProperty(s)) continue;
      for (p in data.positions[s]) {
        if (!data.positions[s].hasOwnProperty(p)) continue;
        if (oldest === null || data.positions[s][p].ts < oldest) { oldest = data.positions[s][p].ts; os = s; op = p; }
      }
    }
    if (os === null) return;
    delete data.positions[os][op];
    n--;
  }
}

function clearPosition(shareId, p) {
  if (data.positions[shareId]) delete data.positions[shareId][p];
  if (data.last && data.last.share === shareId && data.last.path === p) data.last = null;
}

// Position melden. Fast am Ende: Eintrag loeschen (nichts mehr zum Fortsetzen). Ganz am Anfang: ignorieren.
function setPosition(shareId, p, t, d) {
  t = Math.floor(Number(t));
  d = Math.floor(Number(d));
  if (!shareId || !p || !isFinite(t) || !isFinite(d)) return;
  // Ganz am Anfang: ignorieren (loescht keine vorhandene Position). Geloescht wird nur
  // ausdruecklich ("clear") oder wenn die Datei fast zu Ende gesehen ist.
  if (t < MIN_RESUME) return;
  if (!resumable(t, d)) {
    clearPosition(shareId, p);
  } else {
    var now = new Date().getTime();
    if (!data.positions[shareId]) data.positions[shareId] = {};
    data.positions[shareId][p] = { t: t, d: d, ts: now };
    data.last = { share: shareId, path: p, t: t, d: d, ts: now };
    prune();
  }
  save();
}

function positionsFor(shareId) {
  var out = {};
  var m = data.positions[shareId] || {};
  var p;
  for (p in m) if (m.hasOwnProperty(p)) out[p] = { t: m[p].t, d: m[p].d };
  return out;
}

function getLast() {
  return data.last;
}

// Gesamten Verlauf loeschen (Weboberflaeche / blaue Taste in der App)
function clearAll() {
  data.last = null;
  data.positions = {};
  flush();
}

function forgetShare(shareId) {
  delete data.positions[shareId];
  if (data.last && data.last.share === shareId) data.last = null;
  save();
}

load();
process.on('exit', flush);

module.exports = {
  setPosition: setPosition,
  clearPosition: function (shareId, p) { clearPosition(shareId, p); save(); },
  positionsFor: positionsFor,
  getLast: getLast,
  forgetShare: forgetShare,
  clearAll: clearAll,
  count: count,
  resumable: resumable,
  flush: flush,
  file: file
};
