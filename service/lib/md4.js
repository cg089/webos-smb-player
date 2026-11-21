'use strict';
// MD4 in reinem JS. Node mit OpenSSL 3 (und manche TV-Builds) kennen md4 nicht mehr,
// NTLM braucht es aber fuer den NT-Hash.
var bytes = require('./bytes');

function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function md4(input) {
  var len = input.length;
  var blocks = ((len + 8) >>> 6) + 1;
  var msg = bytes.alloc(blocks * 64);
  input.copy(msg, 0);
  msg[len] = 0x80;
  msg.writeUInt32LE((len << 3) >>> 0, blocks * 64 - 8);
  msg.writeUInt32LE(len >>> 29, blocks * 64 - 4);

  var a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  var X = new Array(16);
  var i;

  for (var blk = 0; blk < blocks; blk++) {
    for (i = 0; i < 16; i++) X[i] = msg.readUInt32LE(blk * 64 + i * 4);
    var aa = a, bb = b, cc = c, dd = d;

    // Runde 1
    var s1 = [3, 7, 11, 19];
    for (i = 0; i < 16; i++) {
      var t = (a + ((b & c) | (~b & d)) + X[i]) >>> 0;
      t = rotl(t, s1[i & 3]);
      a = d; d = c; c = b; b = t;
    }
    // Runde 2
    var s2 = [3, 5, 9, 13];
    for (i = 0; i < 16; i++) {
      var k2 = ((i & 3) << 2) + (i >> 2);
      var t2 = (a + ((b & c) | (b & d) | (c & d)) + X[k2] + 0x5a827999) >>> 0;
      t2 = rotl(t2, s2[i & 3]);
      a = d; d = c; c = b; b = t2;
    }
    // Runde 3
    var s3 = [3, 9, 11, 15];
    var order3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    for (i = 0; i < 16; i++) {
      var t3 = (a + (b ^ c ^ d) + X[order3[i]] + 0x6ed9eba1) >>> 0;
      t3 = rotl(t3, s3[i & 3]);
      a = d; d = c; c = b; b = t3;
    }

    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }

  var out = bytes.alloc(16);
  out.writeUInt32LE(a, 0);
  out.writeUInt32LE(b, 4);
  out.writeUInt32LE(c, 8);
  out.writeUInt32LE(d, 12);
  return out;
}

module.exports = md4;
