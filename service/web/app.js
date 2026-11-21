'use strict';
// Konfigurations-Weboberflaeche. Alle dynamischen Inhalte per textContent (kein innerHTML).

function $(id) { return document.getElementById(id); }

function api(method, url, body) {
  var opts = { method: method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(url, opts).then(function (r) {
    return r.json().catch(function () { return { ok: false, error: 'Ungueltige Antwort (HTTP ' + r.status + ')' }; });
  });
}

function show(el, kind, text) {
  el.hidden = false;
  el.className = 'result ' + kind;
  el.textContent = text;
}

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------- Status
function loadInfo() {
  return api('GET', '/api/info').then(function (i) {
    var dl = $('info');
    dl.textContent = '';
    function row(k, v) { dl.appendChild(el('dt', null, k)); dl.appendChild(el('dd', null, v)); }
    var urls = (i.ips || []).map(function (ip) { return 'http://' + ip + ':' + i.port + '/'; });
    row('Adresse dieser Seite', urls.length ? urls.join('  ·  ') : location.host);
    row('Version', i.version + ' (Node ' + i.node + ', ' + i.platform + ')');
    row('Konfiguration', i.configFile);
    row('Zugriffsschutz', i.hasAdminPassword ? 'aktiv' : 'aus');
  }).catch(function () {
    $('info').textContent = 'Status nicht verfügbar.';
  });
}

// ---------------------------------------------------------------- Liste
var shares = [];

function renderList() {
  var ul = $('shareList');
  ul.textContent = '';
  $('emptyHint').hidden = shares.length > 0;
  shares.forEach(function (s) {
    var li = el('li');
    var left = el('div');
    left.appendChild(el('div', 'title', s.name));
    var path = '\\\\' + s.host + (s.port !== 445 ? ':' + s.port : '') + '\\' + s.share + (s.subpath ? '\\' + s.subpath.replace(/\//g, '\\') : '');
    left.appendChild(el('div', 'detail', path + (s.username ? '  ·  Benutzer: ' + s.username : '  ·  Gast')));
    li.appendChild(left);

    var actions = el('div', 'actions');
    var edit = el('button', null, 'Bearbeiten');
    edit.onclick = function () { openForm(s); };
    var del = el('button', 'danger', 'Löschen');
    del.onclick = function () {
      if (!confirm('Freigabe „' + s.name + '“ wirklich löschen?')) return;
      api('DELETE', '/api/shares/' + encodeURIComponent(s.id)).then(loadShares);
    };
    actions.appendChild(edit);
    actions.appendChild(del);
    li.appendChild(actions);
    ul.appendChild(li);
  });
}

function loadShares() {
  return api('GET', '/api/shares').then(function (r) {
    shares = r.shares || [];
    renderList();
    loadInfo();
  });
}

// ---------------------------------------------------------------- Formular
function openForm(s) {
  s = s || {};
  $('formTitle').textContent = s.id ? 'Freigabe bearbeiten' : 'Freigabe hinzufügen';
  $('f_id').value = s.id || '';
  $('f_name').value = s.name || '';
  $('f_host').value = s.host || '';
  $('f_port').value = s.port || 445;
  $('f_share').value = s.share || '';
  $('f_subpath').value = s.subpath || '';
  $('f_username').value = s.username || '';
  $('f_password').value = '';
  $('f_domain').value = s.domain || '';
  $('pwHint').hidden = !s.hasPassword;
  $('result').hidden = true;
  $('formCard').hidden = false;
  $('formCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('f_host').focus();
}

function closeForm() {
  $('formCard').hidden = true;
}

function formData() {
  return {
    id: $('f_id').value || undefined,
    name: $('f_name').value,
    host: $('f_host').value,
    port: $('f_port').value,
    share: $('f_share').value,
    subpath: $('f_subpath').value,
    username: $('f_username').value,
    password: $('f_password').value,
    domain: $('f_domain').value
  };
}

$('btnNew').onclick = function () { openForm(); };
$('btnCancel').onclick = closeForm;

$('btnTest').onclick = function () {
  var btn = $('btnTest');
  btn.disabled = true;
  btn.textContent = 'Teste …';
  api('POST', '/api/test', formData()).then(function (r) {
    if (r.ok) show($('result'), 'ok', r.message + (r.signing ? ' (signierte Verbindung)' : ''));
    else show($('result'), 'err', r.error || 'Verbindung fehlgeschlagen');
  }).catch(function (e) {
    show($('result'), 'err', 'Anfrage fehlgeschlagen: ' + e.message);
  }).then(function () {
    btn.disabled = false;
    btn.textContent = 'Verbindung testen';
  });
};

$('form').onsubmit = function (ev) {
  ev.preventDefault();
  api('POST', '/api/shares', formData()).then(function (r) {
    if (!r.ok) return show($('result'), 'err', r.error || 'Speichern fehlgeschlagen');
    closeForm();
    loadShares();
  }).catch(function (e) {
    show($('result'), 'err', 'Anfrage fehlgeschlagen: ' + e.message);
  });
};

// ---------------------------------------------------------------- Zugriffsschutz
$('btnAdmin').onclick = function () {
  var pw = $('a_pw').value;
  api('POST', '/api/admin', { password: pw }).then(function (r) {
    if (!r.ok) return show($('adminResult'), 'err', r.error || 'Fehlgeschlagen');
    $('a_pw').value = '';
    show($('adminResult'), 'ok', r.hasAdminPassword
      ? 'Zugriffsschutz aktiv. Der Browser fragt ab jetzt nach dem Passwort (Benutzername beliebig).'
      : 'Zugriffsschutz ausgeschaltet.');
    loadInfo();
  });
};

loadShares();
