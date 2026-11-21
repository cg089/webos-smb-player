'use strict';
// NTLMSSP mit NTLMv2 (ohne MIC, ohne Key-Exchange). Ausreichend fuer Samba, Windows, NAS.
var crypto = require('crypto');
var bytes = require('./bytes');
var md4 = require('./md4');

var SIGNATURE = bytes.fromString('NTLMSSP\0', 'binary');

var F_UNICODE = 0x00000001;
var F_REQUEST_TARGET = 0x00000004;
var F_SIGN = 0x00000010;
var F_NTLM = 0x00000200;
var F_ALWAYS_SIGN = 0x00008000;
var F_EXT_SESSIONSEC = 0x00080000;
var F_TARGET_INFO = 0x00800000;
var F_128 = 0x20000000;
var F_56 = 0x80000000;

var CLIENT_FLAGS = (F_UNICODE | F_REQUEST_TARGET | F_SIGN | F_NTLM | F_ALWAYS_SIGN |
  F_EXT_SESSIONSEC | F_TARGET_INFO | F_128 | F_56) >>> 0;

function hmacMd5(key, data) {
  return crypto.createHmac('md5', key).update(data).digest();
}

// Findet die NTLMSSP-Nachricht in einem (evtl. SPNEGO-umhuellten) Sicherheitsblob.
function extractNtlm(blob) {
  for (var i = 0; i + 8 <= blob.length; i++) {
    if (blob[i] === 0x4e && blob.slice(i, i + 8).toString('binary') === 'NTLMSSP\0') {
      return blob.slice(i);
    }
  }
  return null;
}

function createType1() {
  var b = bytes.alloc(32);
  SIGNATURE.copy(b, 0);
  b.writeUInt32LE(1, 8);
  b.writeUInt32LE(CLIENT_FLAGS, 12);
  // Domain- und Workstation-Felder leer, Offset zeigt hinter den Header
  b.writeUInt16LE(0, 16); b.writeUInt16LE(0, 18); b.writeUInt32LE(32, 20);
  b.writeUInt16LE(0, 24); b.writeUInt16LE(0, 26); b.writeUInt32LE(32, 28);
  return b;
}

function parseType2(buf) {
  var msg = extractNtlm(buf);
  if (!msg || msg.length < 48 || msg.readUInt32LE(8) !== 2) {
    throw new Error('Ungueltige NTLM-Antwort des Servers');
  }
  var flags = msg.readUInt32LE(20);
  var challenge = msg.slice(24, 32);
  var tiLen = msg.readUInt16LE(40);
  var tiOff = msg.readUInt32LE(44);
  var targetInfo = bytes.alloc(0);
  var timestamp = null;
  if (tiLen > 0 && tiOff + tiLen <= msg.length) {
    targetInfo = msg.slice(tiOff, tiOff + tiLen);
    // AV-Pairs durchgehen, MsvAvTimestamp (7) suchen
    var p = 0;
    while (p + 4 <= targetInfo.length) {
      var id = targetInfo.readUInt16LE(p);
      var len = targetInfo.readUInt16LE(p + 2);
      if (id === 0) break;
      if (id === 7 && len === 8) timestamp = targetInfo.slice(p + 4, p + 12);
      p += 4 + len;
    }
  }
  return { flags: flags >>> 0, challenge: challenge, targetInfo: targetInfo, timestamp: timestamp };
}

// "DOMAIN\\user" und "user@domain" zerlegen
function splitUser(username, domain) {
  username = username || '';
  domain = domain || '';
  var i = username.indexOf('\\');
  if (i >= 0) {
    if (!domain) domain = username.substring(0, i);
    username = username.substring(i + 1);
  }
  return { username: username, domain: domain };
}

// Liefert { message: Type-3-Nachricht, sessionBaseKey: Buffer }
function createType3(type2, username, password, domain, workstation) {
  var ud = splitUser(username, domain);
  username = ud.username;
  domain = ud.domain;
  workstation = workstation || 'WEBOS';

  var ntowf = md4(bytes.utf16(password || ''));
  var responseKeyNT = hmacMd5(ntowf, bytes.utf16(username.toUpperCase() + domain));

  var clientChallenge = crypto.randomBytes(8);
  var time = type2.timestamp || bytes.msToFiletime(new Date().getTime());

  // NTLMv2-Client-Blob
  var tail = bytes.alloc(4);
  var blob = Buffer.concat([
    bytes.fromArray([0x01, 0x01, 0, 0, 0, 0, 0, 0]),
    time,
    clientChallenge,
    bytes.alloc(4),
    type2.targetInfo,
    tail
  ]);

  var ntProof = hmacMd5(responseKeyNT, Buffer.concat([type2.challenge, blob]));
  var ntResponse = Buffer.concat([ntProof, blob]);
  var lmResponse = Buffer.concat([
    hmacMd5(responseKeyNT, Buffer.concat([type2.challenge, clientChallenge])),
    clientChallenge
  ]);
  var sessionBaseKey = hmacMd5(responseKeyNT, ntProof);

  var domainB = bytes.utf16(domain);
  var userB = bytes.utf16(username);
  var wsB = bytes.utf16(workstation);

  var headerLen = 64;
  var off = headerLen;
  var b = bytes.alloc(headerLen);
  SIGNATURE.copy(b, 0);
  b.writeUInt32LE(3, 8);

  function field(pos, buf) {
    b.writeUInt16LE(buf.length, pos);
    b.writeUInt16LE(buf.length, pos + 2);
    b.writeUInt32LE(off, pos + 4);
    off += buf.length;
  }
  field(12, lmResponse);
  field(20, ntResponse);
  field(28, domainB);
  field(36, userB);
  field(44, wsB);
  field(52, bytes.alloc(0)); // kein EncryptedRandomSessionKey

  var flags = ((CLIENT_FLAGS & type2.flags) | F_UNICODE) >>> 0;
  b.writeUInt32LE(flags, 60);

  var message = Buffer.concat([b, lmResponse, ntResponse, domainB, userB, wsB]);
  return { message: message, sessionBaseKey: sessionBaseKey };
}

module.exports = {
  createType1: createType1,
  parseType2: parseType2,
  createType3: createType3,
  splitUser: splitUser,
  hmacMd5: hmacMd5
};
