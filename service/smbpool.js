'use strict';
// Verbindungspool: pro Freigabe (Server, Benutzer, Share) eine SMB-Verbindung, die von allen
// Anfragen gemeinsam genutzt wird. Tote Verbindungen werden beim naechsten Zugriff neu aufgebaut.
var crypto = require('crypto');
var Smb2Client = require('./lib/smb2').Smb2Client;

var entries = {};   // key -> { client, waiting: [] }

function keyFor(share) {
  var pw = crypto.createHash('sha1').update(String(share.password || '')).digest('hex');
  return [share.host, share.port || 445, share.username || '', share.domain || '', share.share, pw].join('|');
}

function connect(share, cb) {
  var key = keyFor(share);
  var e = entries[key];
  if (e && e.client && e.client.ready && !e.client.dead) return cb(null, e.client);
  if (e && e.connecting) { e.waiting.push(cb); return; }

  e = entries[key] = { client: null, connecting: true, waiting: [cb] };
  var client = new Smb2Client({
    host: share.host,
    port: share.port || 445,
    username: share.username,
    password: share.password,
    domain: share.domain,
    share: share.share
  });
  client.connect(function (err) {
    var waiting = e.waiting;
    e.waiting = [];
    e.connecting = false;
    if (err) {
      if (entries[key] === e) delete entries[key];
      for (var i = 0; i < waiting.length; i++) waiting[i](err);
      return;
    }
    e.client = client;
    client.on('dead', function () { if (entries[key] === e) delete entries[key]; });
    for (var j = 0; j < waiting.length; j++) waiting[j](null, client);
  });
}

// fn(client, done) wird mit einer lebenden Verbindung aufgerufen. Bei Verbindungsfehlern
// (z. B. vom Server beendete Leerlauf-Verbindung) wird genau einmal neu verbunden.
function run(share, fn, cb) {
  var retried = false;
  function attempt() {
    connect(share, function (err, client) {
      if (err) return cb(err);
      fn(client, function (err2, result) {
        if (err2 && err2.code === 'CONNECTION' && !retried) {
          retried = true;
          return attempt();
        }
        cb(err2, result);
      });
    });
  }
  attempt();
}

function closeAll() {
  var k;
  for (k in entries) {
    if (entries.hasOwnProperty(k) && entries[k].client) entries[k].client.close();
  }
  entries = {};
}

module.exports = { connect: connect, run: run, closeAll: closeAll };
