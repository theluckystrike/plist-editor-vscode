'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('../src/core/model');
const B = require('../src/core/binary');
const X = require('../src/core/xml');
const O = require('../src/core/openstep');
const F = require('../src/core/format');
const E = require('../src/core/edits');
const D = require('../src/core/diff');
const C = require('../src/core/check');
const { KEYS } = require('../src/core/keys');

const ROOT = path.join(__dirname, '..');
const sample = (n) => fs.readFileSync(path.join(ROOT, 'samples', n));
const CERT = fs.readFileSync(path.join(__dirname, 'fixtures', 'dev-cert.der'));

function every() {
  return M.dict([
    ['str', M.str('plain')], ['uni', M.str('Grüße 日本 😀')], ['empty', M.str('')], ['esc', M.str('a < b & c > "d"')],
    ['i0', M.int(0)], ['i255', M.int(255)], ['i256', M.int(256)], ['i65536', M.int(65536)], ['big', M.int('4294967296')],
    ['neg', M.int(-1)], ['min', M.int('-9223372036854775808')], ['u64', M.int('18446744073709551615')],
    ['r', M.real(3.25)], ['rneg', M.real(-0.5)], ['t', M.bool(true)], ['f', M.bool(false)],
    ['d', M.date('2026-11-13T02:40:00Z')], ['bytes', M.data(Buffer.from([0, 1, 2, 250, 255]))], ['nodata', M.data(Buffer.alloc(0))],
    ['arr', M.array([M.str('a'), M.int(2), M.array([]), M.dict([])])], ['nested', M.dict([['k', M.dict([['deep', M.array([M.bool(true)])]])]])],
    ['long', M.str('x'.repeat(300))], ['many', M.array(Array.from({ length: 40 }, (_, i) => M.int(i)))],
  ]);
}

test('binary: every type survives a write and read, key order kept', () => {
  const t = every();
  const buf = B.write(t);
  assert.equal(buf.subarray(0, 8).toString(), 'bplist00');
  const back = B.parse(buf);
  assert.ok(M.equal(t, back, true));
  assert.deepEqual(back.v.map(([k]) => k), t.v.map(([k]) => k));
  assert.equal(M.at(back, [11]).v, '18446744073709551615');
  assert.equal(M.at(back, [10]).v, '-9223372036854775808');
});

test('binary: UIDs, sets and null from keyed archives are kept', () => {
  const t = M.dict([['$top', M.dict([['root', { t: 'uid', v: 1 }]])], ['$objects', M.array([M.str('$null'), { t: 'uid', v: 300 }])], ['set', { t: 'array', set: true, v: [M.str('x')] }], ['nil', { t: 'null' }]]);
  const back = B.parse(B.write(t));
  assert.ok(M.equal(t, back, true));
  assert.equal(M.at(back, [2]).set, true);
  assert.equal(M.at(back, [3]).t, 'null');
});

test('binary: equal strings are stored once; large reference tables use 2-byte refs', () => {
  const t = M.array(Array.from({ length: 400 }, (_, i) => M.dict([['name', M.str('same')], ['i', M.int(i)]])));
  const buf = B.write(t);
  assert.equal(buf[buf.length - 32 + 7], 2);
  assert.ok(M.equal(B.parse(buf), t, true));
  assert.ok(buf.length < 400 * 20);
});

test('binary: damaged files give a readable error, never a hang', () => {
  const buf = B.write(every());
  assert.throws(() => B.parse(buf.subarray(0, 30)), /too short|damaged|ends early/);
  const bad = Buffer.from(buf); bad[bad.length - 32 + 6] = 3;
  assert.throws(() => B.parse(bad), /damaged/);
  // a dictionary that holds itself
  const loop = Buffer.from(B.write(M.array([M.array([])])));
  const tableAt = Number(loop.readBigUInt64BE(loop.length - 8));
  const off2 = loop[tableAt + 1];
  loop[off2 + 1] = 0; // inner array (1 item) now refers to object 0, its parent
  loop[off2] = 0xa1;
  assert.throws(() => B.parse(loop), /loop|out of range|damaged/);
  assert.throws(() => B.parse(Buffer.from('bplist01' + 'x'.repeat(40))), /not supported/);
});

test('binary sample: written by our writer, read by our reader', () => {
  const r = F.read(sample('Settings-binary.plist'));
  assert.equal(r.format, 'binary');
  assert.equal(M.at(r.root, [0]).v, '2026-11-12T08:15:00Z');
  assert.equal(M.keyPath(r.root, [4, 1]), 'RecentSearches[1]');
});

test('xml: the Info.plist sample is written back byte for byte', () => {
  const buf = sample('Info.plist');
  const r = F.read(buf, 'Info.plist');
  assert.equal(r.format, 'xml');
  assert.ok(F.write(r.root, 'xml', r.style).equals(buf));
});

test('xml: keeps indent, CRLF, prolog and a missing last newline', () => {
  const text = '<?xml version="1.0" encoding="UTF-8"?>\r\n<plist version="1.0">\r\n<dict>\r\n  <key>a</key>\r\n  <array>\r\n    <integer>1</integer>\r\n  </array>\r\n</dict>\r\n</plist>';
  const r = X.parse(text);
  assert.equal(r.style.indent, '  ');
  assert.equal(X.write(r.root, r.style), text);
});

test('xml: entities, CDATA, comments, hex integers, nan, UIDs and duplicate keys', () => {
  const r = X.parse(`<?xml version="1.0"?><!-- c --><plist version="1.0"><dict>
    <key>e</key><string>&lt;&amp;&gt;&quot;&apos;&#65;&#x42;</string>
    <key>cd</key><string><![CDATA[<raw & text>]]></string>
    <key>h</key><integer>0x1F</integer><key>n</key><real>nan</real><key>inf</key><real>-infinity</real>
    <key>u</key><dict><key>CF$UID</key><integer>7</integer></dict>
    <key>dup</key><string>first</string><key>dup</key><string>second</string>
    <key>d</key><data>
      AAEC
      /w==
    </data>
  </dict></plist>`);
  const g = (k) => r.root.v.find(([x]) => x === k)[1];
  assert.equal(g('e').v, '<&>"\'AB');
  assert.equal(g('cd').v, '<raw & text>');
  assert.equal(g('h').v, '31');
  assert.ok(Number.isNaN(g('n').v));
  assert.equal(g('inf').v, -Infinity);
  assert.deepEqual(g('u'), { t: 'uid', v: 7 });
  assert.equal(g('dup').v, 'second');
  assert.equal(r.root.v.filter(([k]) => k === 'dup').length, 1);
  assert.deepEqual([...Buffer.from(g('d').v, 'base64')], [0, 1, 2, 255]);
  const back = X.parse(X.write(r.root)).root;
  assert.ok(M.equal(back, r.root, true));
});

test('xml: errors name the line; an internal DTD subset is skipped and entities are never defined', () => {
  assert.throws(() => X.parse('<plist>\n<dict>\n<key>a</key>\n</dict></plist>'), /Line 3: The key "a" has no value/);
  assert.throws(() => X.parse('<plist>\n<dict>\n<string>x</string>\n</dict></plist>'), /Line 3: Expected <key>/);
  assert.throws(() => X.parse('<plist><string>&bogus;</string></plist>'), /Unknown entity/);
  assert.throws(() => X.parse('<plist><dict><key>a</key><integer>1.5</integer></dict></plist>'), /not a whole number/);
  const xxe = '<?xml version="1.0"?><!DOCTYPE plist [<!ENTITY x SYSTEM "file:///etc/passwd">]><plist><string>&x;</string></plist>';
  assert.throws(() => X.parse(xxe), /Unknown entity/);
  const ok = X.parse('<?xml version="1.0"?><!DOCTYPE plist [<!ELEMENT plist ANY>]><plist><string>fine</string></plist>');
  assert.equal(ok.root.v, 'fine');
});

test('openstep: dictionaries, arrays, data, comments, escapes, GNUstep types, .strings layout', () => {
  const r = O.parse('// header\n{ a = b; "with space" = "x\\ny\\"z"; list = ( 1, "two", <0001 ff>, ); /* note */ n = { }; t = <*I42>; r = <*R1.5>; y = <*BY>; }');
  assert.equal(r.style.comments, true);
  const g = (k) => r.root.v.find(([x]) => x === k)[1];
  assert.equal(g('with space').v, 'x\ny"z');
  assert.equal(g('list').v.length, 3);
  assert.deepEqual([...Buffer.from(g('list').v[2].v, 'base64')], [0, 1, 255]);
  assert.equal(g('t').v, '42');
  assert.equal(g('y').v, true);
  const s = O.parse('/* Title */\n"Save" = "Sichern";\n"Quit" = "Beenden";\n');
  assert.equal(s.style.stringsFile, true);
  assert.equal(O.write(s.root, s.style), 'Save = Sichern;\nQuit = Beenden;\n');
  assert.throws(() => O.parse('{ a = b '), /not closed|Expected/);
});

test('openstep: the writer quotes what CoreFoundation needs quoted (+, spaces, empty)', () => {
  assert.equal(O.quote('gnu++20'), '"gnu++20"');
  assert.equal(O.quote('$(SRCROOT)'), '"$(SRCROOT)"');
  assert.equal(O.quote('a.b-c_d:e$f'), 'a.b-c_d:e$f');
  assert.equal(O.quote('plain/path.txt'), 'plain/path.txt');
  assert.equal(O.quote(''), '""');
  assert.equal(O.quote('a b'), '"a b"');
  const t = M.dict([['k', M.str('gnu++20')], ['d', M.data(Buffer.from('abcd'))], ['a', M.array([M.str('x y')])]]);
  assert.ok(M.equal(O.parse(O.write(t)).root, t, true));
  assert.deepEqual(O.lossy(M.dict([['n', M.int(1)], ['s', M.str('x')]])), ['n']);
});

test('format: detection of binary, XML (UTF-8, BOM, UTF-16), OpenStep, JSON and signed profiles', () => {
  const t = M.dict([['k', M.str('v')]]);
  assert.equal(F.read(B.write(t)).format, 'binary');
  const xml = X.write(t);
  assert.equal(F.read(Buffer.from(xml)).format, 'xml');
  const bom = F.read(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)]));
  assert.equal(bom.style.encoding, 'utf8bom');
  assert.ok(F.write(bom.root, 'xml', bom.style).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  const u16 = F.encodeText(xml, 'utf16le');
  const r16 = F.read(u16);
  assert.equal(r16.style.encoding, 'utf16le');
  assert.ok(F.write(r16.root, 'xml', r16.style).equals(u16));
  assert.equal(F.read(Buffer.from('{ k = v; }')).format, 'openstep');
  assert.equal(F.read(Buffer.from('{"k": [1, 2.5, true, "x"]}'), 'a.json').format, 'json');
  const profile = Buffer.concat([Buffer.from([0x30, 0x82, 0x10, 0x00, 0x06, 0x09]), Buffer.from(xml), Buffer.from([0xa0, 0x82, 0, 1, 2, 3])]);
  const p = F.read(profile, 'x.mobileprovision');
  assert.equal(p.format, 'profile');
  assert.equal(p.readOnly, true);
  assert.equal(M.at(p.root, [0]).v, 'v');
  assert.throws(() => F.read(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])), /not a plist/);
  assert.equal(F.read(Buffer.alloc(0)).empty, true);
});

test('format: losses explain what a target format cannot hold', () => {
  const t = every();
  assert.match(F.losses(t, 'json').join(' '), /dates become ISO text.*data becomes base64/);
  assert.match(F.losses(t, 'openstep').join(' '), /become text/);
  assert.deepEqual(F.losses(t, 'binary'), []);
  assert.deepEqual(F.losses(t, 'xml'), []);
  const j = JSON.parse(F.write(t, 'json').toString());
  assert.equal(j.u64, '18446744073709551615');
  assert.equal(j.i255, 255);
  assert.ok(M.equal(F.fromJson({ a: [1, 2.5, 'x', true] }), M.dict([['a', M.array([M.int(1), M.real(2.5), M.str('x'), M.bool(true)])]])));
  assert.throws(() => F.fromJson({ a: null }), /null/);
});

test('model: parseValue and retype behave like Xcode', () => {
  assert.equal(M.parseValue('integer', ' 42 ').v, '42');
  assert.throws(() => M.parseValue('integer', '4.2'), /whole number/);
  assert.equal(M.parseValue('bool', 'yes').v, true);
  assert.throws(() => M.parseValue('bool', 'maybe'), /YES or NO/);
  assert.equal(M.parseValue('date', '2026-01-02T03:04:05Z').v, '2026-01-02T03:04:05Z');
  assert.throws(() => M.parseValue('date', 'soon'), /not a date/);
  assert.equal(Buffer.from(M.parseValue('data', '<00 1f A2>').v, 'base64').toString('hex'), '001fa2');
  assert.throws(() => M.parseValue('data', 'xyz'), /hex/);
  assert.throws(() => M.int('99999999999999999999999'), /outside/);
  assert.equal(M.retype(M.str('42'), 'integer').v, '42');
  assert.equal(M.retype(M.str('YES'), 'bool').v, true);
  assert.equal(M.retype(M.int(7), 'string').v, '7');
  assert.equal(M.retype(M.str('abc'), 'integer').v, '0');
  const d = M.retype(M.array([M.str('a'), M.str('b')]), 'dict');
  assert.deepEqual(d.v.map(([k]) => k), ['Item 0', 'Item 1']);
  assert.equal(M.display(M.data(Buffer.alloc(40, 7))).endsWith('...>'), true);
});

test('edits: every operation has an exact inverse', () => {
  const doc = { root: every() };
  const before = M.clone(doc.root);
  const ops = [
    { op: 'setKey', path: [0], key: 'renamed' },
    { op: 'replace', path: [4], node: M.str('now a string') },
    { op: 'insert', parent: [19], index: 1, node: M.int(9) },
    { op: 'insert', parent: [], index: 0, key: 'first', node: M.bool(true) },
    { op: 'remove', parent: [], index: 3 },
    { op: 'move', parent: [], from: 0, to: 5 },
    { op: 'replace', path: [], node: M.array([]) },
  ];
  const inverses = [];
  for (const op of ops) inverses.push(E.apply(doc, op));
  for (const inv of inverses.reverse()) E.apply(doc, inv);
  assert.ok(M.equal(doc.root, before, true));
  assert.throws(() => E.apply(doc, { op: 'setKey', path: [0], key: 'uni' }), /already/);
  assert.throws(() => E.apply(doc, { op: 'setKey', path: [19, 0], key: 'x' }), /no key/);
  assert.throws(() => E.apply(doc, { op: 'insert', parent: [0], index: 0, node: M.str('') }), /dictionary or an array/);
  assert.equal(E.uniqueKey(M.dict([['New item', M.str('')], ['New item 2', M.str('')]]), 'New item'), 'New item 3');
});

test('diff: key order is ignored; lists of values show single additions', () => {
  const a = M.dict([['A', M.str('1')], ['B', M.array([M.str('x'), M.str('y'), M.str('z')])], ['C', M.int(1)], ['gone', M.bool(true)]]);
  const b = M.dict([['C', M.int(2)], ['A', M.str('1')], ['B', M.array([M.str('x'), M.str('new'), M.str('y'), M.str('z')])], ['T', M.str('t')]]);
  const ch = D.compare(a, b);
  assert.deepEqual(ch.map((c) => `${c.kind} ${c.path}`).sort(), ['added B[1]', 'added T', 'changed C', 'removed gone']);
  assert.deepEqual(D.compare(a, M.clone(a)), []);
  const ty = D.compare(M.dict([['k', M.str('1')]]), M.dict([['k', M.int(1)]]));
  assert.equal(ty[0].kind, 'type');
  assert.match(D.markdown(ch, 'old.plist', 'new.plist'), /\| changed \| C \| 1 \| 2 \|/);
  assert.equal(D.compare(M.dict([['d', M.date('2026-01-01T00:00:00.400Z')]]), M.dict([['d', M.date('2026-01-01T00:00:00Z')]])).length, 0);
});

test('check: the sample Info.plist has no errors', () => {
  const r = C.check(F.read(sample('Info.plist')).root, 'Info.plist');
  assert.equal(r.kind, 'info');
  assert.deepEqual(r.issues.filter((i) => i.level === 'error'), []);
  assert.ok(r.summary.some(([k, v]) => k === 'Bundle identifier' && v === 'com.example.trailnotes'));
});

test('check: Info.plist problems App Store Connect refuses are found', () => {
  const root = F.read(sample('Info.plist')).root;
  const doc = { root: M.clone(root) };
  const set = (k, n) => { const i = doc.root.v.findIndex(([x]) => x === k); if (i >= 0) doc.root.v[i][1] = n; else doc.root.v.push([k, n]); };
  set('CFBundleShortVersionString', M.str('2.4 beta'));
  set('CFBundleVersion', M.int(318));
  set('NSCameraUsageDescription', M.str(''));
  set('NSMicrophoneUsageDescription', M.str('needed'));
  set('NSLocationAlwaysAndWhenInUseUsageDescription', M.str('Records your hikes in the background with GPS.'));
  doc.root.v = doc.root.v.filter(([k]) => k !== 'UILaunchStoryboardName' && k !== 'NSLocationWhenInUseUsageDescription');
  set('CFBundleURLTypes', M.array([M.dict([['CFBundleURLSchemes', M.array([M.str('trail notes://'), M.str('https')])]])]));
  set('NSAppTransportSecurity', M.dict([['NSAllowsArbitraryLoads', M.bool(true)]]));
  set('UIBackgroundModes', M.array([M.str('fetch'), M.str('gps')]));
  const r = C.check(doc.root, 'Info.plist');
  const paths = r.issues.map((i) => `${i.level} ${i.path}`);
  for (const want of ['error CFBundleShortVersionString', 'error CFBundleVersion', 'error NSCameraUsageDescription', 'warning NSMicrophoneUsageDescription', 'error NSLocationWhenInUseUsageDescription', 'error UILaunchStoryboardName', 'error CFBundleURLTypes[0].CFBundleURLSchemes[0]', 'error CFBundleURLTypes[0].CFBundleURLSchemes[1]', 'warning NSAppTransportSecurity.NSAllowsArbitraryLoads', 'warning UIBackgroundModes']) {
    assert.ok(paths.includes(want), `${want} in ${paths.join(', ')}`);
  }
  assert.ok(r.issues.findIndex((i) => i.level === 'warning') > r.issues.findLastIndex((i) => i.level === 'error'));
  assert.match(C.markdown(r, 'Info.plist'), /errors, .* warnings/);
});

test('check: provisioning profile summary, certificate, expiry and App ID match', () => {
  const now = Date.parse('2026-11-13T00:00:00Z');
  const prof = M.dict([
    ['AppIDName', M.str('Trail Notes')], ['CreationDate', M.date('2026-01-10T00:00:00Z')], ['ExpirationDate', M.date('2026-11-30T00:00:00Z')],
    ['DeveloperCertificates', M.array([M.data(CERT)])], ['Entitlements', M.dict([['application-identifier', M.str('TESTTEAM01.com.example.trailnotes')], ['get-task-allow', M.bool(true)], ['aps-environment', M.str('development')]])],
    ['Name', M.str('Trail Notes Dev')], ['ProvisionedDevices', M.array([M.str('00008110-001A2B3C4D5E6F70'), M.str('bad id')])], ['TeamIdentifier', M.array([M.str('TESTTEAM01')])], ['TeamName', M.str('Example Corp')],
  ]);
  const r = C.check(prof, 'dev.mobileprovision', { now, X509: crypto.X509Certificate });
  assert.equal(r.kind, 'profile');
  const s = Object.fromEntries(r.summary);
  assert.equal(s.Type, 'Development');
  assert.match(s.Expires, /17 days left/);
  assert.equal(s.Devices, '2');
  assert.match(r.certificates[0].name, /Apple Development: Test Person/);
  assert.equal(r.certificates[0].expired, false);
  assert.ok(r.issues.some((i) => i.level === 'warning' && i.path === 'ExpirationDate'));
  assert.ok(r.issues.some((i) => i.path === 'ProvisionedDevices[1]'));
  const late = C.check(prof, 'dev.mobileprovision', { now: Date.parse('2040-01-01T00:00:00Z'), X509: crypto.X509Certificate });
  assert.ok(late.issues.some((i) => i.level === 'error' && /expired/.test(i.message) && i.path === 'ExpirationDate'));
  assert.ok(late.certificates[0].expired);
  const info = F.read(sample('Info.plist')).root;
  assert.deepEqual(C.matchProfile(info, prof), { ok: true, id: 'com.example.trailnotes', appId: 'TESTTEAM01.com.example.trailnotes' });
  const other = M.clone(prof); other.v[4][1].v[0][1] = M.str('TESTTEAM01.com.example.other');
  const mis = C.check(info, 'Info.plist', { profiles: [{ name: 'other.mobileprovision', root: other }] });
  assert.ok(mis.issues.some((i) => /does not match the App ID/.test(i.message)));
  const wild = M.clone(prof); wild.v[4][1].v[0][1] = M.str('TESTTEAM01.com.example.*');
  assert.equal(C.matchProfile(info, wild).ok, true);
});

test('check: entitlements and privacy manifests', () => {
  const ent = M.dict([['aps-environment', M.str('prod')], ['com.apple.developer.associated-domains', M.array([M.str('applinks:example.com'), M.str('https://example.com/path')])]]);
  const r = C.check(ent, 'App.entitlements');
  assert.equal(r.kind, 'entitlements');
  assert.deepEqual(r.issues.map((i) => i.path).sort(), ['aps-environment', 'com.apple.developer.associated-domains[1]']);
  const pm = M.dict([['NSPrivacyTracking', M.bool(true)], ['NSPrivacyAccessedAPITypes', M.array([M.dict([['NSPrivacyAccessedAPIType', M.str('NSPrivacyAccessedAPICategoryUserDefaults')]])])]]);
  const p = C.check(pm, 'PrivacyInfo.xcprivacy');
  assert.equal(p.kind, 'privacy');
  assert.ok(p.issues.some((i) => /reason code/.test(i.message)));
  assert.ok(p.issues.some((i) => i.path === 'NSPrivacyTrackingDomains'));
});

test('keys: about 120 known keys, each with a name, a type and a note', () => {
  const n = Object.keys(KEYS).length;
  assert.ok(n >= 120 && n <= 140, String(n));
  for (const [k, v] of Object.entries(KEYS)) { assert.ok(v.name && v.note && v.type, k); }
});
