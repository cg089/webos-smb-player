'use strict';
// Schlanker SMB2-Client (Dialekte 2.0.2 und 2.1) fuer reines Lesen.
// Authentifizierung: NTLMv2. Signierung (HMAC-SHA256) wird genutzt, wenn der Server sie verlangt.
// Geschrieben in ES5, damit er auch auf dem alten Node des webOS-4-Fernsehers laeuft.

var net = require('net');
var crypto = require('crypto');
var util = require('util');
var events = require('events');
var Readable = require('stream').Readable;
var bytes = require('./bytes');
var ntlm = require('./ntlm');

var CMD = {
  NEGOTIATE: 0, SESSION_SETUP: 1, LOGOFF: 2, TREE_CONNECT: 3, TREE_DISCONNECT: 4,
  CREATE: 5, CLOSE: 6, FLUSH: 7, READ: 8, WRITE: 9, ECHO: 13, QUERY_DIRECTORY: 14
};

var ST = {
  SUCCESS: 0x00000000,
  PENDING: 0x00000103,
  NO_MORE_FILES: 0x80000006,
  MORE_PROCESSING: 0xC0000016,
  NO_SUCH_FILE: 0xC000000F,
  END_OF_FILE: 0xC0000011
};

var ERR_TEXT = {
  0xC000006D: ['LOGON_FAILURE', 'Anmeldung fehlgeschlagen (Benutzer oder Passwort falsch)'],
  0xC000006E: ['ACCOUNT_RESTRICTION', 'Anmeldung fehlgeschlagen (Kontobeschraenkung)'],
  0xC0000070: ['LOGON_FAILURE', 'Anmeldung fehlgeschlagen (Anmeldezeit/Arbeitsstation nicht erlaubt)'],
  0xC0000071: ['LOGON_FAILURE', 'Passwort abgelaufen'],
  0xC0000072: ['LOGON_FAILURE', 'Konto deaktiviert'],
  0xC0000234: ['LOGON_FAILURE', 'Konto gesperrt'],
  0xC0000022: ['ACCESS_DENIED', 'Zugriff verweigert'],
  0xC00000CC: ['BAD_NETWORK_NAME', 'Freigabe nicht gefunden (Freigabename pruefen)'],
  0xC0000034: ['NOT_FOUND', 'Datei oder Ordner nicht gefunden'],
  0xC000000F: ['NOT_FOUND', 'Datei oder Ordner nicht gefunden'],
  0xC000003A: ['NOT_FOUND', 'Pfad nicht gefunden'],
  0xC0000033: ['NOT_FOUND', 'Ungueltiger Dateiname'],
  0xC0000103: ['NOT_A_DIRECTORY', 'Kein Ordner'],
  0xC00000BA: ['IS_A_DIRECTORY', 'Ist ein Ordner'],
  0xC0000035: ['EXISTS', 'Objekt existiert bereits'],
  0xC0000043: ['SHARING_VIOLATION', 'Datei ist gesperrt (von anderem Programm in Benutzung)'],
  0xC0000203: ['SESSION_EXPIRED', 'Sitzung abgelaufen'],
  0xC00000BB: ['NOT_SUPPORTED', 'Der Server unterstuetzt SMB 2.x nicht (nur SMB 3 oder SMB 1?). Bitte SMB 2.1 am Server erlauben.'],
  0xC000020C: ['CONNECTION', 'Verbindung vom Server getrennt'],
  0xC0000011: ['END_OF_FILE', 'Dateiende']
};

function SmbError(code, message, status) {
  var e = new Error(message);
  e.code = code;
  e.status = status;
  e.isSmbError = true;
  return e;
}

function statusError(status) {
  var info = ERR_TEXT[status];
  if (info) return SmbError(info[0], info[1], status);
  return SmbError('SMB_ERROR', 'SMB-Fehler 0x' + (status >>> 0).toString(16), status);
}

function connError(msg) {
  return SmbError('CONNECTION', msg || 'Verbindung getrennt');
}

var CREDIT_UNIT = 65536;
var PROTO = bytes.fromArray([0xFE, 0x53, 0x4D, 0x42]);

function Smb2Client(opts) {
  events.EventEmitter.call(this);
  this.opts = opts;
  this.socket = null;
  this.chunks = [];
  this.have = 0;
  this.pending = {};
  this.pendingCount = 0;
  this.msgId = 0;
  this.credits = 1;
  this.queue = [];
  this.sessionId = bytes.alloc(8);
  this.treeId = 0;
  this.dialect = 0;
  this.signingRequired = false;
  this.signing = false;
  this.signingKey = null;
  this.dead = false;
  this.ready = false;
  this.lastActivity = Date.now();
  this.keepAliveTimer = null;
}
util.inherits(Smb2Client, events.EventEmitter);

// ---------------------------------------------------------------- Verbindungsaufbau

Smb2Client.prototype.connect = function (cb) {
  var self = this;
  var done = false;
  function finish(err) {
    if (done) return;
    done = true;
    if (err) {
      self._die(err);
      cb(err);
    } else {
      self.ready = true;
      self._startKeepAlive();
      cb(null, self);
    }
  }

  var sock = net.connect({ host: this.opts.host, port: this.opts.port || 445 });
  this.socket = sock;
  sock.setNoDelay(true);
  sock.setKeepAlive(true, 30000);
  sock.setTimeout(15000, function () {
    if (!self.ready) finish(connError('Zeitueberschreitung beim Verbinden mit ' + self.opts.host));
  });

  sock.on('connect', function () {
    sock.setTimeout(0);
    self._handshake(finish);
  });
  sock.on('data', function (d) { self._onData(d); });
  sock.on('error', function (e) {
    var msg = 'Verbindung zu ' + self.opts.host + ' fehlgeschlagen';
    if (e && e.code === 'ECONNREFUSED') msg += ' (Port ' + (self.opts.port || 445) + ' abgelehnt)';
    else if (e && e.code === 'ENOTFOUND') msg = 'Server "' + self.opts.host + '" nicht gefunden';
    else if (e && e.code === 'EHOSTUNREACH') msg += ' (Host nicht erreichbar)';
    else if (e && e.message) msg += ' (' + e.message + ')';
    var err = connError(msg);
    if (!self.ready) finish(err); else self._die(err);
  });
  sock.on('close', function () {
    var err = connError(self.ready ? 'Verbindung getrennt' : 'Server hat die Verbindung geschlossen (SMB2 nicht unterstuetzt?)');
    if (!self.ready) finish(err); else self._die(err);
  });
};

Smb2Client.prototype._handshake = function (cb) {
  var self = this;
  var o = this.opts;

  // 1. NEGOTIATE
  var body = bytes.alloc(40);
  body.writeUInt16LE(36, 0);
  body.writeUInt16LE(2, 2);            // Anzahl Dialekte
  body.writeUInt16LE(1, 4);            // Signing enabled
  // Capabilities bleiben 0 (kein LARGE_MTU): jede Anfrage kostet genau 1 Credit, Reads max. 64 KB
  crypto.randomBytes(16).copy(body, 12);
  body.writeUInt16LE(0x0202, 36);
  body.writeUInt16LE(0x0210, 38);

  this._request(CMD.NEGOTIATE, function () { return { body: body }; }, function (err, r) {
    if (err) return cb(err);
    var f = r.frame;
    if (f.length < 128) return cb(SmbError('PROTOCOL', 'Ungueltige Negotiate-Antwort'));
    var secMode = f.readUInt16LE(66);
    self.dialect = f.readUInt16LE(68);
    if (self.dialect !== 0x0202 && self.dialect !== 0x0210) {
      return cb(SmbError('PROTOCOL', 'Der Server verlangt SMB 3.x (Dialekt 0x' + self.dialect.toString(16) +
        '). Bitte SMB 2.1 am Server erlauben.'));
    }
    self.signingRequired = (secMode & 0x2) !== 0 || !!o.forceSigning;

    // 2. SESSION_SETUP Schritt 1 (NTLM Type 1)
    self._sessionSetup(ntlm.createType1(), function (err2, r2) {
      if (err2) return cb(err2);
      if (r2.status !== ST.MORE_PROCESSING) return cb(statusError(r2.status));
      var t2;
      try { t2 = ntlm.parseType2(r2.blob); } catch (e) { return cb(SmbError('PROTOCOL', e.message)); }

      var user = o.username || '';
      var pass = o.password || '';
      var t3 = ntlm.createType3(t2, user, pass, o.domain || '', 'WEBOS');

      // 3. SESSION_SETUP Schritt 2 (NTLM Type 3)
      self._sessionSetup(t3.message, function (err3, r3) {
        if (err3) return cb(err3);
        if (r3.status !== ST.SUCCESS) return cb(statusError(r3.status));
        var guest = (r3.sessionFlags & 0x1) !== 0 || (r3.sessionFlags & 0x2) !== 0;
        if (self.signingRequired && !guest) {
          self.signing = true;
          self.signingKey = t3.sessionBaseKey;
        }
        self.verifyResponses = !!o.verifySignatures;

        // 4. TREE_CONNECT
        var path = bytes.utf16('\\\\' + o.host + '\\' + o.share);
        var tb = bytes.alloc(8 + path.length);
        tb.writeUInt16LE(9, 0);
        tb.writeUInt16LE(72, 4);
        tb.writeUInt16LE(path.length, 6);
        path.copy(tb, 8);
        self._request(CMD.TREE_CONNECT, function () { return { body: tb }; }, function (err4, r4) {
          if (err4) {
            // Je nach Server kommt hier "Pfad/Datei nicht gefunden" statt BAD_NETWORK_NAME
            if (err4.code === 'NOT_FOUND') err4 = statusError(0xC00000CC);
            return cb(err4);
          }
          if (r4.status !== ST.SUCCESS) return cb(statusError(r4.status));
          self.treeId = r4.frame.readUInt32LE(36);
          cb(null);
        });
      });
    });
  });
};

Smb2Client.prototype._sessionSetup = function (blob, cb) {
  var body = bytes.alloc(24 + blob.length);
  body.writeUInt16LE(25, 0);
  body[3] = 1;                          // Signing enabled
  body.writeUInt16LE(88, 12);
  body.writeUInt16LE(blob.length, 14);
  blob.copy(body, 24);
  this._request(CMD.SESSION_SETUP, function () { return { body: body }; }, function (err, r) {
    if (err) return cb(err);
    var f = r.frame;
    var out = { status: r.status, sessionFlags: 0, blob: bytes.alloc(0) };
    if (r.status === ST.MORE_PROCESSING || r.status === ST.SUCCESS) {
      // SessionId aus dem Header uebernehmen
      f.copy(this.sessionId, 0, 40, 48);
      if (f.length >= 72) {
        out.sessionFlags = f.readUInt16LE(66);
        var off = f.readUInt16LE(68);
        var len = f.readUInt16LE(70);
        if (len > 0 && off + len <= f.length) out.blob = f.slice(off, off + len);
      }
    }
    cb(null, out);
  }.bind(this), true);
};

// ---------------------------------------------------------------- Senden / Empfangen

// builder() -> { body }. allowStatus: Status-Fehler nicht automatisch melden.
Smb2Client.prototype._request = function (cmd, builder, cb, allowStatus) {
  if (this.dead) return cb(connError());
  var item = { cmd: cmd, builder: builder, cb: cb, allowStatus: !!allowStatus };
  if (this.credits < 1) {
    this.queue.push(item);
    return;
  }
  this._dispatch(item);
};

Smb2Client.prototype._dispatch = function (item) {
  var built = item.builder();
  var id = this.msgId;
  this.msgId += 1;
  this.credits -= 1;

  var body = built.body;
  var msg = bytes.alloc(64 + body.length);
  PROTO.copy(msg, 0);
  msg.writeUInt16LE(64, 4);
  // CreditCharge bleibt 0 (kein Multi-Credit)
  msg.writeUInt16LE(item.cmd, 12);
  msg.writeUInt16LE(64, 14);                       // angeforderte Credits
  msg.writeUInt32LE(id >>> 0, 24);
  msg.writeUInt32LE(Math.floor(id / 4294967296), 28);
  msg.writeUInt32LE(0xFEFF, 32);                   // ProcessId
  var needsTree = item.cmd !== CMD.NEGOTIATE && item.cmd !== CMD.SESSION_SETUP && item.cmd !== CMD.TREE_CONNECT;
  if (needsTree) msg.writeUInt32LE(this.treeId, 36);
  if (item.cmd !== CMD.NEGOTIATE) this.sessionId.copy(msg, 40);
  body.copy(msg, 64);

  if (this.signing && item.cmd !== CMD.NEGOTIATE && item.cmd !== CMD.SESSION_SETUP) {
    msg.writeUInt32LE(0x8, 16);                    // SIGNED
    var sig = crypto.createHmac('sha256', this.signingKey).update(msg).digest();
    sig.copy(msg, 48, 0, 16);
  }

  var frame = bytes.alloc(4 + msg.length);
  frame[1] = (msg.length >> 16) & 0xFF;
  frame[2] = (msg.length >> 8) & 0xFF;
  frame[3] = msg.length & 0xFF;
  msg.copy(frame, 4);

  this.pending[id] = item;
  this.pendingCount++;
  this.lastActivity = Date.now();
  var self = this;
  try {
    this.socket.write(frame);
  } catch (e) {
    delete this.pending[id];
    this.pendingCount--;
    self._die(connError(e.message));
  }
};

Smb2Client.prototype._flushQueue = function () {
  while (this.queue.length && this.credits >= 1 && !this.dead) {
    this._dispatch(this.queue.shift());
  }
};

Smb2Client.prototype._take = function (n) {
  var all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.have);
  var out = all.slice(0, n);
  var rest = all.slice(n);
  this.chunks = rest.length ? [rest] : [];
  this.have = rest.length;
  return out;
};

Smb2Client.prototype._peekLength = function () {
  var head = this.chunks[0];
  if (head.length < 4) {
    head = Buffer.concat(this.chunks, this.have);
    this.chunks = [head];
  }
  if (head[0] !== 0) return -1;
  return (head[1] << 16) | (head[2] << 8) | head[3];
};

Smb2Client.prototype._onData = function (data) {
  this.chunks.push(data);
  this.have += data.length;
  this.lastActivity = Date.now();
  while (this.have >= 4 && !this.dead) {
    var len = this._peekLength();
    if (len < 0) return this._die(SmbError('PROTOCOL', 'Ungueltiges Netzwerkprotokoll'));
    if (this.have < 4 + len) return;
    var frame = this._take(4 + len).slice(4);
    this._onFrame(frame);
  }
};

Smb2Client.prototype._onFrame = function (frame) {
  if (frame.length < 64 || frame[0] !== 0xFE || frame[1] !== 0x53) {
    return this._die(SmbError('PROTOCOL', 'Ungueltige SMB2-Antwort'));
  }
  if (this.verifyResponses && this.signing && (frame.readUInt32LE(16) & 0x8) !== 0) {
    var copy = bytes.alloc(frame.length);
    frame.copy(copy);
    copy.fill(0, 48, 64);
    var expect = crypto.createHmac('sha256', this.signingKey).update(copy).digest().slice(0, 16);
    if (expect.toString('hex') !== frame.slice(48, 64).toString('hex')) {
      return this._die(SmbError('SIGNATURE', 'Signaturpruefung der Server-Antwort fehlgeschlagen'));
    }
    this.signatureVerified = (this.signatureVerified || 0) + 1;
  }
  var status = frame.readUInt32LE(8);
  var grant = frame.readUInt16LE(14);
  var id = frame.readUInt32LE(24) + frame.readUInt32LE(28) * 4294967296;
  this.credits += grant;
  var item = this.pending[id];
  if (!item) { this._flushQueue(); return; }

  if (status === ST.PENDING) {          // Zwischenantwort, die echte folgt
    this._flushQueue();
    return;
  }
  delete this.pending[id];
  this.pendingCount--;

  var result = { status: status, frame: frame };
  if (!item.allowStatus && status !== ST.SUCCESS) {
    item.cb(statusError(status), result);
  } else {
    item.cb(null, result);
  }
  this._flushQueue();
};

Smb2Client.prototype._die = function (err) {
  if (this.dead) return;
  this.dead = true;
  this.ready = false;
  if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
  var pend = this.pending;
  var q = this.queue;
  this.pending = {};
  this.pendingCount = 0;
  this.queue = [];
  try { if (this.socket) this.socket.destroy(); } catch (e) { /* ignorieren */ }
  var k;
  for (k in pend) if (pend.hasOwnProperty(k)) { try { pend[k].cb(err); } catch (e1) { /* */ } }
  for (var i = 0; i < q.length; i++) { try { q[i].cb(err); } catch (e2) { /* */ } }
  this.emit('dead', err);
};

Smb2Client.prototype._startKeepAlive = function () {
  var self = this;
  this.keepAliveTimer = setInterval(function () {
    if (self.dead || Date.now() - self.lastActivity < 25000) return;
    var b = bytes.alloc(4);
    b.writeUInt16LE(4, 0);
    self._request(CMD.ECHO, function () { return { body: b }; }, function () { /* Antwort egal */ });
  }, 15000);
  if (this.keepAliveTimer.unref) this.keepAliveTimer.unref();
};

Smb2Client.prototype.close = function () {
  this._die(connError('Verbindung geschlossen'));
};

// ---------------------------------------------------------------- Dateioperationen

function smbPath(p) {
  // '/a/b/c' oder 'a\\b' -> 'a\\b\\c', ".." ist verboten
  var parts = String(p || '').split(/[\\/]+/);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === '' || parts[i] === '.') continue;
    if (parts[i] === '..') throw SmbError('BAD_PATH', 'Ungueltiger Pfad');
    out.push(parts[i]);
  }
  return out.join('\\');
}

// kind: 'dir' | 'file' | 'any'
Smb2Client.prototype._open = function (path, kind, cb) {
  var name;
  try { name = smbPath(path); } catch (e) { return cb(e); }
  var nameB = bytes.utf16(name);
  var body = bytes.alloc(56 + Math.max(nameB.length, 1));
  body.writeUInt16LE(57, 0);
  body.writeUInt32LE(2, 4);                                // Impersonation
  body.writeUInt32LE(kind === 'any' ? 0x00100080 : 0x00100081, 24);
  body.writeUInt32LE(7, 32);                               // Share: read|write|delete
  body.writeUInt32LE(1, 36);                               // FILE_OPEN
  body.writeUInt32LE(kind === 'dir' ? 0x1 : (kind === 'file' ? 0x40 : 0), 40);
  body.writeUInt16LE(120, 44);
  body.writeUInt16LE(nameB.length, 46);
  nameB.copy(body, 56);

  this._request(CMD.CREATE, function () { return { body: body }; }, function (err, r) {
    if (err) return cb(err);
    var f = r.frame;
    if (f.length < 144) return cb(SmbError('PROTOCOL', 'Ungueltige Create-Antwort'));
    var attrs = f.readUInt32LE(120);
    var fid = bytes.alloc(16);
    f.copy(fid, 0, 128, 144);
    cb(null, {
      fid: fid,
      size: bytes.read64LE(f, 112),
      isDir: (attrs & 0x10) !== 0,
      mtime: bytes.filetimeToMs(f, 88)
    });
  });
};

Smb2Client.prototype._closeHandle = function (fid, cb) {
  var body = bytes.alloc(24);
  body.writeUInt16LE(24, 0);
  fid.copy(body, 8);
  this._request(CMD.CLOSE, function () { return { body: body }; }, function () {
    if (cb) cb();
  });
};

Smb2Client.prototype.stat = function (path, cb) {
  var self = this;
  this._open(path, 'any', function (err, h) {
    if (err) return cb(err);
    self._closeHandle(h.fid, function () {
      cb(null, { size: h.size, isDir: h.isDir, mtime: h.mtime });
    });
  });
};

Smb2Client.prototype.readdir = function (path, cb) {
  var self = this;
  this._open(path, 'dir', function (err, h) {
    if (err) return cb(err);
    var entries = [];
    var first = true;
    var pattern = bytes.utf16('*');

    function finish(e) {
      self._closeHandle(h.fid, function () {
        if (e) return cb(e);
        cb(null, entries);
      });
    }

    function next() {
      var body = bytes.alloc(32 + pattern.length);
      body.writeUInt16LE(33, 0);
      body[2] = 3;                                         // FileBothDirectoryInformation
      body[3] = first ? 0x1 : 0;                           // RESTART_SCANS
      h.fid.copy(body, 8);
      body.writeUInt16LE(96, 24);
      body.writeUInt16LE(pattern.length, 26);
      body.writeUInt32LE(65536, 28);
      pattern.copy(body, 32);
      first = false;
      self._request(CMD.QUERY_DIRECTORY, function () { return { body: body }; }, function (e2, r) {
        if (e2) {
          if (e2.status === ST.NO_MORE_FILES || e2.status === ST.NO_SUCH_FILE) return finish(null);
          return finish(e2);
        }
        var f = r.frame;
        var off = f.readUInt16LE(66);
        var len = f.readUInt32LE(68);
        var data = f.slice(off, off + len);
        var p = 0;
        while (p + 94 <= data.length) {
          var nextOff = data.readUInt32LE(p);
          var attrs = data.readUInt32LE(p + 56);
          var nameLen = data.readUInt32LE(p + 60);
          var nm = data.toString('utf16le', p + 94, p + 94 + nameLen);
          if (nm !== '.' && nm !== '..' && !((attrs & 0x2) && (attrs & 0x4))) {
            entries.push({
              name: nm,
              isDir: (attrs & 0x10) !== 0,
              size: bytes.read64LE(data, p + 40),
              mtime: bytes.filetimeToMs(data, p + 24)
            });
          }
          if (nextOff === 0) break;
          p += nextOff;
        }
        next();
      });
    }
    next();
  });
};

// Oeffnet eine Datei zum Lesen. Ergebnis: SmbFile mit size, read(), stream(), close().
Smb2Client.prototype.openFile = function (path, cb) {
  var self = this;
  this._open(path, 'file', function (err, h) {
    if (err) return cb(err);
    if (h.isDir) {
      return self._closeHandle(h.fid, function () { cb(SmbError('IS_A_DIRECTORY', 'Ist ein Ordner')); });
    }
    cb(null, new SmbFile(self, h));
  });
};

function SmbFile(client, h) {
  this.client = client;
  this.fid = h.fid;
  this.size = h.size;
  this.mtime = h.mtime;
  this.closed = false;
}

// Liest bis zu `length` Byte ab `offset`. Kann weniger liefern; cb(err, buffer).
SmbFile.prototype.read = function (offset, length, cb) {
  var self = this;
  if (this.closed) return cb(connError('Datei geschlossen'));
  var c = this.client;
  c._request(CMD.READ, function () {
    var body = bytes.alloc(49);
    body.writeUInt16LE(49, 0);
    body.writeUInt32LE(Math.min(length, CREDIT_UNIT), 4);
    bytes.write64LE(body, 8, offset);
    self.fid.copy(body, 16);
    return { body: body };
  }, function (err, r) {
    if (err) return cb(err);
    var f = r.frame;
    var dataOff = f[66];
    var dataLen = f.readUInt32LE(68);
    cb(null, f.slice(dataOff, dataOff + dataLen));
  });
};

SmbFile.prototype.close = function (cb) {
  if (this.closed) { if (cb) cb(); return; }
  this.closed = true;
  if (this.client.dead) { if (cb) cb(); return; }
  this.client._closeHandle(this.fid, cb);
};

// Gepipelinetes Lesen im Bereich [start, endInclusive]
SmbFile.prototype.stream = function (start, endInclusive) {
  return new FileStream(this, start, endInclusive);
};

// Wenige Anfragen gleichzeitig: der TV hat nur ~860 MB RAM. 4 x 64 KB reichen auch fuer UHD-Material.
var PIPELINE_DEPTH = 4;

function FileStream(file, start, endInclusive) {
  Readable.call(this, { highWaterMark: 256 * 1024 });
  this.file = file;
  this.pos = start;
  this.endExcl = endInclusive + 1;
  this.slots = [];
  this.inflight = 0;
  this.want = false;
  this.dead = false;
  this.ended = false;
}
util.inherits(FileStream, Readable);

FileStream.prototype._read = function () {
  this.want = true;
  this._pump();
};

FileStream.prototype.abort = function () {
  this.dead = true;
  this.slots = [];
};

FileStream.prototype._pump = function () {
  var chunk = CREDIT_UNIT;
  while (!this.dead && this.want && this.inflight < PIPELINE_DEPTH && this.pos < this.endExcl) {
    var len = Math.min(chunk, this.endExcl - this.pos);
    var slot = { offset: this.pos, want: len, got: 0, bufs: [], done: false };
    this.pos += len;
    this.slots.push(slot);
    this.inflight++;
    this._issue(slot);
  }
  this._drain();
};

FileStream.prototype._issue = function (slot) {
  var self = this;
  this.file.read(slot.offset + slot.got, slot.want - slot.got, function (err, data) {
    if (self.dead) return;
    if (err) {
      if (err.code !== 'END_OF_FILE') {
        self.dead = true;
        self.emit('error', err);
        return;
      }
      slot.done = true;
    } else {
      if (data.length > 0) {
        slot.bufs.push(data);
        slot.got += data.length;
      }
      if (data.length > 0 && slot.got < slot.want) return self._issue(slot);
      slot.done = true;
    }
    self.inflight--;
    self._drain();
    self._pump();
  });
};

FileStream.prototype._drain = function () {
  while (!this.dead && this.slots.length && this.slots[0].done) {
    var s = this.slots.shift();
    var data = s.bufs.length === 1 ? s.bufs[0] : Buffer.concat(s.bufs);
    if (data.length) {
      if (!this.push(data)) this.want = false;
    }
  }
  if (!this.dead && !this.ended && this.slots.length === 0 && this.pos >= this.endExcl) {
    this.ended = true;
    this.push(null);
  }
};

module.exports = {
  Smb2Client: Smb2Client,
  SmbError: SmbError,
  smbPath: smbPath
};
