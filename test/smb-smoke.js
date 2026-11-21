'use strict';
// Smoke-Test des SMB2-Clients gegen einen echten SMB-Server.
// Aufruf: SMB_HOST=127.0.0.1 SMB_PORT=4455 SMB_USER=test SMB_PASS=secret SMB_SHARE=Medien \
//         LOCAL_DIR=/pfad/zum/freigabeordner node test/smb-smoke.js
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var Smb2Client = require('../service/lib/smb2').Smb2Client;

var env = process.env;
var LOCAL = env.LOCAL_DIR;
var failures = 0;

function check(name, ok, extra) {
  console.log((ok ? 'OK    ' : 'FEHLER') + ' ' + name + (extra ? '  ' + extra : ''));
  if (!ok) failures++;
}

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function streamToBuffer(stream, cb) {
  var parts = [];
  stream.on('data', function (d) { parts.push(d); });
  stream.on('error', function (e) { cb(e); });
  stream.on('end', function () { cb(null, Buffer.concat(parts)); });
}

var client = new Smb2Client({
  host: env.SMB_HOST || '127.0.0.1',
  port: parseInt(env.SMB_PORT || '445', 10),
  username: env.SMB_USER || '',
  password: env.SMB_PASS || '',
  domain: env.SMB_DOMAIN || '',
  share: env.SMB_SHARE,
  // SMB_SIGN=1: Signierung erzwingen und die Signaturen der Server-Antworten pruefen
  forceSigning: env.SMB_SIGN === '1',
  verifySignatures: env.SMB_SIGN === '1'
});

var t0 = Date.now();
client.connect(function (err) {
  if (err) { check('Verbindung', false, err.message); return process.exit(1); }
  check('Verbindung/Anmeldung', true, '(Dialekt 0x' + client.dialect.toString(16) + ', signing=' + client.signing + ')');

  client.readdir('', function (e1, root) {
    check('readdir Wurzel', !e1 && root.length > 0, e1 ? e1.message : root.map(function (x) { return (x.isDir ? '[' + x.name + ']' : x.name); }).join(', '));

    client.readdir('Filme', function (e2, films) {
      var names = (films || []).map(function (x) { return x.name; }).sort();
      check('readdir Unterordner', !e2 && names.indexOf('gross.mkv') >= 0, e2 ? e2.message : names.join(', '));

      client.readdir('Filme/Serien Ü', function (e3, sub) {
        var subNames = (sub || []).map(function (x) { return x.name; });
        check('readdir Umlaute', !e3 && subNames.indexOf('Folge äö 1.mkv') >= 0, e3 ? e3.message : subNames.join(', '));

        client.stat('Filme/gross.mkv', function (e4, st) {
          var realSize = LOCAL ? fs.statSync(path.join(LOCAL, 'Filme/gross.mkv')).size : st && st.size;
          check('stat Datei', !e4 && st.size === realSize && !st.isDir, e4 ? e4.message : 'size=' + (st && st.size));

          client.stat('Filme', function (e5, st2) {
            check('stat Ordner', !e5 && st2.isDir, e5 ? e5.message : '');

            client.stat('gibt/es/nicht.mkv', function (e6) {
              check('stat nicht vorhanden -> Fehler NOT_FOUND', e6 && e6.code === 'NOT_FOUND', e6 ? e6.code + ': ' + e6.message : 'kein Fehler');

              client.openFile('Filme/gross.mkv', function (e7, f) {
                if (e7) { check('openFile', false, e7.message); return process.exit(1); }
                var local = LOCAL ? fs.readFileSync(path.join(LOCAL, 'Filme/gross.mkv')) : null;

                var s1 = f.stream(1000, 70000); // Bereich ueber Chunk-Grenze
                streamToBuffer(s1, function (e8, b1) {
                  check('Stream Bereich 1000-70000', !e8 && b1.length === 69001 && (!local || sha(b1) === sha(local.slice(1000, 70001))),
                    e8 ? e8.message : 'len=' + (b1 && b1.length));

                  var from = f.size - 12345;
                  streamToBuffer(f.stream(from, f.size - 1), function (e9, b2) {
                    check('Stream Dateiende', !e9 && b2.length === 12345 && (!local || sha(b2) === sha(local.slice(from))),
                      e9 ? e9.message : 'len=' + (b2 && b2.length));

                    var t1 = Date.now();
                    streamToBuffer(f.stream(0, f.size - 1), function (e10, b3) {
                      var secs = (Date.now() - t1) / 1000;
                      check('Stream komplett', !e10 && b3.length === f.size && (!local || sha(b3) === sha(local)),
                        e10 ? e10.message : (b3.length / 1048576).toFixed(1) + ' MB in ' + secs.toFixed(2) + ' s = ' + (b3.length / 1048576 / secs).toFixed(0) + ' MB/s');

                      f.close(function () {
                        if (env.SMB_SIGN === '1') {
                          check('Signatur der Server-Antworten verifiziert', client.signatureVerified > 0, 'Antworten: ' + client.signatureVerified);
                        }
                        client.close();
                        console.log(failures === 0 ? '\nAlles in Ordnung (' + (Date.now() - t0) + ' ms).' : '\n' + failures + ' Fehler.');
                        process.exit(failures === 0 ? 0 : 1);
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});
