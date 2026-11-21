'use strict';
// Kleine Buffer-Helfer, kompatibel mit alten Node-Versionen (kein Buffer.alloc/from vorausgesetzt).

function alloc(n) {
  if (typeof Buffer.alloc === 'function') return Buffer.alloc(n);
  var b = new Buffer(n);
  b.fill(0);
  return b;
}

function fromString(str, enc) {
  if (typeof Buffer.from === 'function' && Buffer.from !== Uint8Array.from) return Buffer.from(str, enc);
  return new Buffer(str, enc);
}

function fromArray(arr) {
  if (typeof Buffer.from === 'function' && Buffer.from !== Uint8Array.from) return Buffer.from(arr);
  return new Buffer(arr);
}

function utf16(str) {
  return fromString(str, 'utf16le');
}

var TWO32 = 4294967296;

// 64-Bit little endian lesen (als Zahl, bis 2^53 exakt)
function read64LE(buf, off) {
  return buf.readUInt32LE(off + 4) * TWO32 + buf.readUInt32LE(off);
}

function write64LE(buf, off, value) {
  var hi = Math.floor(value / TWO32);
  var lo = value - hi * TWO32;
  buf.writeUInt32LE(lo >>> 0, off);
  buf.writeUInt32LE(hi >>> 0, off + 4);
}

// Windows-FILETIME (100ns seit 1601) -> JS-Millisekunden seit 1970
function filetimeToMs(buf, off) {
  var hi = buf.readUInt32LE(off + 4);
  var lo = buf.readUInt32LE(off);
  if (hi === 0 && lo === 0) return 0;
  return Math.floor((hi * TWO32 + lo) / 10000) - 11644473600000;
}

// JS-Millisekunden -> FILETIME als 8 Byte (ohne BigInt, auch fuer altes Node)
function msToFiletime(ms) {
  var t = ms + 11644473600000;
  var lo = (t % TWO32) * 10000;
  var carry = Math.floor(lo / TWO32);
  lo = lo % TWO32;
  var hi = Math.floor(t / TWO32) * 10000 + carry;
  var b = alloc(8);
  b.writeUInt32LE(lo >>> 0, 0);
  b.writeUInt32LE(hi >>> 0, 4);
  return b;
}

module.exports = {
  alloc: alloc,
  fromString: fromString,
  fromArray: fromArray,
  utf16: utf16,
  read64LE: read64LE,
  write64LE: write64LE,
  filetimeToMs: filetimeToMs,
  msToFiletime: msToFiletime
};
