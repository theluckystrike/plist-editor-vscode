'use strict';
// Info.plist, entitlements and provisioning profile check (Zovo Pro). Pure: takes trees, returns a report.
// Report: { kind, title, summary: [[label, value]], issues: [{ level: error|warning|info, path, message, fix }], certificates? }
const M = require('./model');
const { KEYS, PRIVACY } = require('./keys');

const get = (n, k) => (n && n.t === 'dict' ? (n.v.find(([x]) => x === k) || [])[1] : undefined);
const sv = (n) => (n && n.t === 'string' ? n.v : undefined);
const isVar = (s) => /\$\(|\$\{/.test(s || '');
const LABEL = { dict: 'Dictionary', array: 'Array', string: 'String', integer: 'Number', real: 'Number', bool: 'Boolean', date: 'Date', data: 'Data' };

function kindOf(root, fileName = '') {
  const base = String(fileName).split(/[\\/]/).pop().toLowerCase();
  if (root.t !== 'dict') return 'other';
  if (get(root, 'ExpirationDate') && (get(root, 'DeveloperCertificates') || get(root, 'Entitlements'))) return 'profile';
  if (base.endsWith('.entitlements') || get(root, 'com.apple.security.app-sandbox') || get(root, 'application-identifier') || get(root, 'aps-environment') || get(root, 'keychain-access-groups')) return 'entitlements';
  if (base.endsWith('.xcprivacy') || get(root, 'NSPrivacyAccessedAPITypes') || get(root, 'NSPrivacyTracking')) return 'privacy';
  if (base === 'info.plist' || get(root, 'CFBundleIdentifier') || get(root, 'CFBundleExecutable')) return 'info';
  return 'other';
}

function checkTypes(root, issues) {
  (function walk(n, p) {
    if (n.t !== 'dict') { if (n.t === 'array') n.v.forEach((c, i) => walk(c, `${p}[${i}]`)); return; }
    for (const [k, c] of n.v) {
      const path = p ? `${p}.${k}` : k;
      const want = KEYS[k] && KEYS[k].type;
      const have = c.t === 'real' ? 'integer' : c.t;
      if (want && have !== want && !(want === 'string' && c.t === 'string')) {
        issues.push({ level: 'error', path, message: `${k} should be a ${LABEL[want]}, but it is a ${LABEL[c.t] || c.t}.`, fix: `Change the type of ${k} to ${LABEL[want]}.` });
      }
      walk(c, path);
    }
  })(root, '');
}

function checkInfo(root, issues, summary) {
  const id = sv(get(root, 'CFBundleIdentifier'));
  const short = sv(get(root, 'CFBundleShortVersionString'));
  const build = sv(get(root, 'CFBundleVersion'));
  const ios = !!(get(root, 'LSRequiresIPhoneOS') || get(root, 'UIDeviceFamily') || get(root, 'MinimumOSVersion') || get(root, 'UILaunchStoryboardName') || get(root, 'UIApplicationSceneManifest') || get(root, 'UISupportedInterfaceOrientations'));
  const pkg = sv(get(root, 'CFBundlePackageType'));
  const isApp = !pkg || pkg === 'APPL' || isVar(pkg);
  summary.push(['Bundle identifier', id || '(missing)'], ['Version', `${short || '?'} (${build || '?'})`], ['Platform', ios ? 'iOS, iPadOS or visionOS' : 'macOS or not set'], ['Display name', sv(get(root, 'CFBundleDisplayName')) || sv(get(root, 'CFBundleName')) || '(none)']);

  if (!id) issues.push({ level: 'error', path: 'CFBundleIdentifier', message: 'The bundle identifier is missing.', fix: 'Add CFBundleIdentifier (usually $(PRODUCT_BUNDLE_IDENTIFIER)).' });
  else if (!isVar(id) && !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(id)) issues.push({ level: 'error', path: 'CFBundleIdentifier', message: `"${id}" is not a valid bundle identifier: use letters, digits, hyphens and dots, with at least one dot.`, fix: 'Use reverse-DNS form, for example com.example.myapp.' });
  if (!short) issues.push({ level: isApp ? 'error' : 'warning', path: 'CFBundleShortVersionString', message: 'The version string is missing.', fix: 'Add CFBundleShortVersionString, for example 1.0 or $(MARKETING_VERSION).' });
  else if (!isVar(short) && !/^\d+(\.\d+){0,2}$/.test(short)) issues.push({ level: 'error', path: 'CFBundleShortVersionString', message: `"${short}" is not accepted by App Store Connect: up to three whole numbers separated by dots.`, fix: 'Use a form like 1.4 or 2.0.3.' });
  if (!build) issues.push({ level: isApp ? 'error' : 'warning', path: 'CFBundleVersion', message: 'The build number is missing.', fix: 'Add CFBundleVersion, for example 1 or $(CURRENT_PROJECT_VERSION).' });
  else if (!isVar(build) && !/^\d+(\.\d+){0,2}$/.test(build)) issues.push({ level: 'error', path: 'CFBundleVersion', message: `"${build}" is not a valid build number: up to three whole numbers separated by dots.`, fix: 'Use a form like 42 or 1.4.42.' });
  if (!get(root, 'CFBundleExecutable') && isApp) issues.push({ level: 'warning', path: 'CFBundleExecutable', message: 'CFBundleExecutable is missing, so the system cannot find the app binary.', fix: 'Add CFBundleExecutable = $(EXECUTABLE_NAME).' });
  const name = sv(get(root, 'CFBundleName'));
  if (name && !isVar(name) && name.length > 15) issues.push({ level: 'info', path: 'CFBundleName', message: `The bundle name has ${name.length} characters; Apple suggests 15 or fewer.`, fix: 'Put a longer name in CFBundleDisplayName.' });

  // privacy usage descriptions
  for (const k of Object.keys(PRIVACY)) {
    const n = get(root, k);
    if (!n) continue;
    const s = sv(n);
    if (s === undefined) continue;
    if (!s.trim()) issues.push({ level: 'error', path: k, message: `${k} is empty. iOS shows this text when the app asks for access, and App Review rejects an empty one.`, fix: 'Write one sentence that says why the app needs this access.' });
    else if (!isVar(s) && (s.trim().length < 12 || /^(todo|tbd|test|description|usage|required|needed|xxx)/i.test(s.trim()))) issues.push({ level: 'warning', path: k, message: `"${s}" is too vague for a permission prompt. App Review asks for a clear reason.`, fix: 'Say what the app does with the access, for example "Scans receipts with the camera to fill in expenses."' });
  }
  if (get(root, 'NSLocationAlwaysUsageDescription') && !get(root, 'NSLocationAlwaysAndWhenInUseUsageDescription') && ios) issues.push({ level: 'error', path: 'NSLocationAlwaysUsageDescription', message: 'iOS 11 and later read NSLocationAlwaysAndWhenInUseUsageDescription, not this old key.', fix: 'Add NSLocationAlwaysAndWhenInUseUsageDescription and NSLocationWhenInUseUsageDescription.' });
  if (get(root, 'NSLocationAlwaysAndWhenInUseUsageDescription') && !get(root, 'NSLocationWhenInUseUsageDescription')) issues.push({ level: 'error', path: 'NSLocationWhenInUseUsageDescription', message: 'An app that asks for "always" location must also have the "when in use" description.', fix: 'Add NSLocationWhenInUseUsageDescription.' });
  if (get(root, 'NSBluetoothPeripheralUsageDescription') && !get(root, 'NSBluetoothAlwaysUsageDescription') && ios) issues.push({ level: 'error', path: 'NSBluetoothAlwaysUsageDescription', message: 'iOS 13 and later need NSBluetoothAlwaysUsageDescription for Bluetooth.', fix: 'Add NSBluetoothAlwaysUsageDescription.' });

  const modes = get(root, 'UIBackgroundModes');
  const modeList = modes && modes.t === 'array' ? modes.v.map(sv).filter(Boolean) : [];
  if (modeList.includes('location') && !get(root, 'NSLocationAlwaysAndWhenInUseUsageDescription')) issues.push({ level: 'warning', path: 'UIBackgroundModes', message: 'Background location is on, but there is no NSLocationAlwaysAndWhenInUseUsageDescription.', fix: 'Add the description, or remove "location" if the app needs location only while open.' });
  if (modeList.includes('bluetooth-central') && !get(root, 'NSBluetoothAlwaysUsageDescription')) issues.push({ level: 'warning', path: 'UIBackgroundModes', message: 'Background Bluetooth is on, but there is no NSBluetoothAlwaysUsageDescription.', fix: 'Add NSBluetoothAlwaysUsageDescription.' });
  const knownModes = ['audio', 'location', 'voip', 'external-accessory', 'bluetooth-central', 'bluetooth-peripheral', 'fetch', 'remote-notification', 'processing', 'nearby-interaction', 'push-to-talk', 'newsstand-content'];
  for (const m of modeList) if (!knownModes.includes(m)) issues.push({ level: 'warning', path: 'UIBackgroundModes', message: `"${m}" is not a background mode iOS knows.`, fix: `Use one of: ${knownModes.join(', ')}.` });

  if (ios && isApp && !get(root, 'UILaunchStoryboardName') && !get(root, 'UILaunchScreen')) issues.push({ level: 'error', path: 'UILaunchStoryboardName', message: 'iOS apps need a launch screen; without one, App Store Connect refuses the upload.', fix: 'Add UILaunchStoryboardName (a storyboard) or an empty UILaunchScreen dictionary.' });
  if (ios && isApp && !get(root, 'ITSAppUsesNonExemptEncryption')) issues.push({ level: 'info', path: 'ITSAppUsesNonExemptEncryption', message: 'Without ITSAppUsesNonExemptEncryption, App Store Connect asks the export compliance question for every build.', fix: 'Add ITSAppUsesNonExemptEncryption = NO if the app uses only standard encryption such as HTTPS.' });
  const ipadOr = get(root, 'UISupportedInterfaceOrientations~ipad');
  const fam = get(root, 'UIDeviceFamily');
  const ipad = fam && fam.t === 'array' && fam.v.some((x) => String(x.v) === '2');
  if (ipad && ipadOr && ipadOr.t === 'array' && ipadOr.v.length < 4 && !(get(root, 'UIRequiresFullScreen') || {}).v) issues.push({ level: 'warning', path: 'UISupportedInterfaceOrientations~ipad', message: 'An iPad app that supports multitasking must list all four orientations, or App Store Connect refuses it.', fix: 'Add the missing orientations, or set UIRequiresFullScreen to YES.' });
  const caps = get(root, 'UIRequiredDeviceCapabilities');
  if (caps && caps.t === 'array' && caps.v.some((x) => sv(x) === 'armv7')) issues.push({ level: 'warning', path: 'UIRequiredDeviceCapabilities', message: '"armv7" is an old 32-bit requirement; current Xcode builds arm64 only.', fix: 'Replace armv7 with arm64 or remove it.' });

  const ats = get(root, 'NSAppTransportSecurity');
  if (ats && (get(ats, 'NSAllowsArbitraryLoads') || {}).v === true) issues.push({ level: 'warning', path: 'NSAppTransportSecurity.NSAllowsArbitraryLoads', message: 'App Transport Security is off for every connection. App Review asks for a reason.', fix: 'Use NSExceptionDomains for the few hosts that need HTTP, or NSAllowsArbitraryLoadsInWebContent for web views.' });
  const ex = ats && get(ats, 'NSExceptionDomains');
  if (ex && ex.t === 'dict') {
    for (const [d, c] of ex.v) if ((get(c, 'NSExceptionAllowsInsecureHTTPLoads') || {}).v === true) issues.push({ level: 'info', path: `NSAppTransportSecurity.NSExceptionDomains.${d}`, message: `Plain HTTP is allowed for ${d}.`, fix: 'Keep it only if the server cannot use HTTPS.' });
  }
  const queried = get(root, 'LSApplicationQueriesSchemes');
  if (queried && queried.t === 'array' && queried.v.length > 50) issues.push({ level: 'warning', path: 'LSApplicationQueriesSchemes', message: `${queried.v.length} queried schemes: iOS reads only the first 50.`, fix: 'Keep the 50 the app needs most.' });

  const types = get(root, 'CFBundleURLTypes');
  if (types && types.t === 'array') {
    const seen = new Map();
    types.v.forEach((t, i) => {
      const schemes = get(t, 'CFBundleURLSchemes');
      if (!schemes || schemes.t !== 'array' || !schemes.v.length) { issues.push({ level: 'warning', path: `CFBundleURLTypes[${i}]`, message: 'This URL type has no CFBundleURLSchemes.', fix: 'Add the scheme names or remove the entry.' }); return; }
      schemes.v.forEach((s, j) => {
        const v = sv(s) || '';
        const p = `CFBundleURLTypes[${i}].CFBundleURLSchemes[${j}]`;
        if (!isVar(v) && !/^[A-Za-z][A-Za-z0-9+.-]*$/.test(v)) issues.push({ level: 'error', path: p, message: `"${v}" is not a valid URL scheme: start with a letter, then letters, digits, + . or - only.`, fix: 'Remove "://", spaces and other characters.' });
        if (/^(https?|mailto|tel|sms|facetime|file)$/i.test(v)) issues.push({ level: 'error', path: p, message: `"${v}" is a scheme the system owns; the app cannot claim it.`, fix: 'Use a scheme of your own, such as com.example.myapp.' });
        if (seen.has(v.toLowerCase())) issues.push({ level: 'warning', path: p, message: `The scheme "${v}" is listed twice.`, fix: 'Remove the duplicate.' });
        seen.set(v.toLowerCase(), p);
      });
    });
  }
}

function certInfo(b64, X509, now = Date.now()) {
  try {
    const c = new X509(Buffer.from(b64, 'base64'));
    const cn = (/CN=([^\n]+)/.exec(c.subject) || [])[1] || c.subject.split('\n')[0];
    return { name: cn, serial: c.serialNumber, validFrom: new Date(c.validFrom).toISOString().slice(0, 10), validTo: new Date(c.validTo).toISOString().slice(0, 10), expired: new Date(c.validTo).getTime() < now, sha1: (c.fingerprint || '').replace(/:/g, '') };
  } catch (e) {
    return { name: '(not a readable certificate)', error: String(e.message || e) };
  }
}

function profileType(root) {
  const ent = get(root, 'Entitlements');
  const debug = (get(ent, 'get-task-allow') || {}).v === true;
  const devices = get(root, 'ProvisionedDevices');
  if ((get(root, 'ProvisionsAllDevices') || {}).v === true) return 'In-house (enterprise)';
  if (devices && devices.v.length) return debug ? 'Development' : 'Ad hoc';
  return 'App Store';
}

function checkProfile(root, issues, summary, now, X509) {
  const ent = get(root, 'Entitlements');
  const appId = sv(get(ent, 'application-identifier')) || sv(get(ent, 'com.apple.application-identifier')) || '';
  const exp = get(root, 'ExpirationDate');
  const days = exp ? Math.floor((Date.parse(exp.v) - now) / 86400000) : null;
  const devices = get(root, 'ProvisionedDevices');
  const team = get(root, 'TeamIdentifier');
  summary.push(
    ['Profile name', sv(get(root, 'Name')) || '(none)'],
    ['Type', profileType(root)],
    ['App ID', appId || '(none)'],
    ['App ID name', sv(get(root, 'AppIDName')) || ''],
    ['Team', `${sv(get(root, 'TeamName')) || ''}${team && team.v[0] ? ` (${team.v[0].v})` : ''}`],
    ['Platform', (get(root, 'Platform') || { v: [] }).v.map((x) => x.v).join(', ')],
    ['Created', (get(root, 'CreationDate') || {}).v || ''],
    ['Expires', exp ? `${exp.v}${days !== null ? ` (${days < 0 ? `expired ${-days} days ago` : `${days} days left`})` : ''}` : '(none)'],
    ['Devices', devices ? String(devices.v.length) : (get(root, 'ProvisionsAllDevices') || {}).v ? 'all' : '0'],
    ['Entitlements', ent && ent.t === 'dict' ? ent.v.map(([k]) => k).join(', ') : '(none)'],
  );
  if (days !== null && days < 0) issues.push({ level: 'error', path: 'ExpirationDate', message: `The profile expired ${-days} days ago. Apps signed with it no longer install or start.`, fix: 'Make a new profile in the developer account and download it.' });
  else if (days !== null && days <= 30) issues.push({ level: 'warning', path: 'ExpirationDate', message: `The profile expires in ${days} days.`, fix: 'Renew it before it expires.' });
  if (appId.endsWith('*')) issues.push({ level: 'info', path: 'Entitlements.application-identifier', message: 'A wildcard App ID: push notifications, Sign in with Apple and other capabilities do not work with it.', fix: 'Use an explicit App ID if the app needs those capabilities.' });
  if (profileType(root) === 'App Store' && (get(ent, 'get-task-allow') || {}).v === true) issues.push({ level: 'error', path: 'Entitlements.get-task-allow', message: 'A distribution profile allows debugging.', fix: 'Download the distribution profile again.' });
  const aps = sv(get(ent, 'aps-environment'));
  if (aps) summary.push(['Push environment', aps]);
  const certs = [];
  const dc = get(root, 'DeveloperCertificates');
  if (dc && dc.t === 'array' && X509) {
    for (const c of dc.v) if (c.t === 'data') certs.push(certInfo(c.v, X509, now));
    const live = certs.filter((c) => !c.error && !c.expired);
    certs.forEach((c, i) => { if (c.expired) issues.push({ level: live.length ? 'warning' : 'error', path: `DeveloperCertificates[${i}]`, message: `The certificate "${c.name}" expired on ${c.validTo}.`, fix: live.length ? 'Other certificates in the profile are still valid.' : 'Make a new certificate and a new profile.' }); });
  }
  if (devices && devices.t === 'array') {
    const seen = new Set();
    devices.v.forEach((d, i) => {
      const u = sv(d) || '';
      if (!/^([0-9a-fA-F]{40}|[0-9A-F]{8}-[0-9A-F]{16})$/.test(u)) issues.push({ level: 'info', path: `ProvisionedDevices[${i}]`, message: `"${u}" does not look like a device UDID.`, fix: '' });
      if (seen.has(u)) issues.push({ level: 'info', path: `ProvisionedDevices[${i}]`, message: `The device ${u} is listed twice.`, fix: '' });
      seen.add(u);
    });
  }
  return certs;
}

function checkEntitlements(root, issues, summary) {
  summary.push(['Entitlements', String(root.v.length)]);
  for (const [k, c] of root.v) summary.push([k, c.t === 'array' ? c.v.map((x) => M.display(x)).join(', ') : M.display(c)]);
  if ((get(root, 'get-task-allow') || {}).v === true) issues.push({ level: 'info', path: 'get-task-allow', message: 'Debugging is allowed. Xcode sets this for development builds; distribution signing removes it.', fix: '' });
  const aps = sv(get(root, 'aps-environment'));
  if (aps && !['development', 'production'].includes(aps)) issues.push({ level: 'error', path: 'aps-environment', message: `"${aps}" is not a push environment.`, fix: 'Use development or production.' });
  const ad = get(root, 'com.apple.developer.associated-domains');
  if (ad && ad.t === 'array') ad.v.forEach((d, i) => { const s = sv(d) || ''; if (!/^(applinks|webcredentials|activitycontinuation|appclips):[^\s/]+$/.test(s) && !isVar(s)) issues.push({ level: 'error', path: `com.apple.developer.associated-domains[${i}]`, message: `"${s}" is not a valid associated domain.`, fix: 'Use a form like applinks:example.com (no https:// and no path).' }); });
}

function checkPrivacyManifest(root, issues, summary) {
  const tracking = (get(root, 'NSPrivacyTracking') || {}).v;
  const domains = get(root, 'NSPrivacyTrackingDomains');
  const apis = get(root, 'NSPrivacyAccessedAPITypes');
  summary.push(['Tracking', tracking === true ? 'YES' : tracking === false ? 'NO' : '(not set)'], ['Tracking domains', domains ? String(domains.v.length) : '0'], ['Required reason APIs', apis ? String(apis.v.length) : '0']);
  if (tracking === true && (!domains || !domains.v.length)) issues.push({ level: 'warning', path: 'NSPrivacyTrackingDomains', message: 'Tracking is YES but no tracking domains are listed.', fix: 'List the domains the app contacts for tracking.' });
  if (apis && apis.t === 'array') apis.v.forEach((a, i) => {
    const type = sv(get(a, 'NSPrivacyAccessedAPIType'));
    const reasons = get(a, 'NSPrivacyAccessedAPITypeReasons');
    if (!type) issues.push({ level: 'error', path: `NSPrivacyAccessedAPITypes[${i}]`, message: 'An entry has no NSPrivacyAccessedAPIType.', fix: 'Add the API category, for example NSPrivacyAccessedAPICategoryUserDefaults.' });
    if (!reasons || reasons.t !== 'array' || !reasons.v.length) issues.push({ level: 'error', path: `NSPrivacyAccessedAPITypes[${i}]`, message: `${type || 'An API type'} has no reason code. App Store Connect refuses uploads without one.`, fix: 'Add a reason code such as CA92.1 to NSPrivacyAccessedAPITypeReasons.' });
  });
}

/** Cross-check an Info.plist bundle id against a profile's App ID. */
function matchProfile(info, profile) {
  const id = sv(get(info, 'CFBundleIdentifier')) || '';
  const app = sv(get(get(profile, 'Entitlements'), 'application-identifier')) || '';
  const bundlePart = app.replace(/^[A-Z0-9]{10}\./, '');
  if (!id || !app || isVar(id)) return null;
  const ok = bundlePart.endsWith('*') ? id.startsWith(bundlePart.slice(0, -1)) : id === bundlePart;
  return { ok, id, appId: app };
}

function check(root, fileName = '', opts = {}) {
  const now = opts.now || Date.now();
  const kind = kindOf(root, fileName);
  const issues = [];
  const summary = [];
  let certificates;
  const title = { info: 'Info.plist check', profile: 'Provisioning profile check', entitlements: 'Entitlements check', privacy: 'Privacy manifest check', other: 'Plist check' }[kind];
  if (kind === 'info') checkInfo(root, issues, summary);
  else if (kind === 'profile') certificates = checkProfile(root, issues, summary, now, opts.X509);
  else if (kind === 'entitlements') checkEntitlements(root, issues, summary);
  else if (kind === 'privacy') checkPrivacyManifest(root, issues, summary);
  else summary.push(['Top value', M.TYPE_LABEL[root.t]], ['Items', String(M.count(root) - 1)]);
  checkTypes(root, issues);
  if (opts.profiles && kind === 'info') {
    for (const p of opts.profiles) {
      const m = matchProfile(root, p.root);
      if (!m) continue;
      if (m.ok) summary.push([`Profile ${p.name}`, `App ID ${m.appId} matches`]);
      else issues.push({ level: 'error', path: 'CFBundleIdentifier', message: `The bundle id ${m.id} does not match the App ID ${m.appId} of the profile ${p.name}.`, fix: 'Change the bundle id or use a profile for this App ID.' });
    }
  }
  const order = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  return { kind, title, summary, issues, certificates };
}

function markdown(r, fileName) {
  const c = { error: 0, warning: 0, info: 0 };
  for (const i of r.issues) c[i.level]++;
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = [`# ${r.title}: ${fileName}`, '', `${c.error} errors, ${c.warning} warnings, ${c.info} notes.`, '', '| | |', '|---|---|'];
  for (const [k, v] of r.summary) lines.push(`| ${cell(k)} | ${cell(v)} |`);
  if (r.certificates && r.certificates.length) {
    lines.push('', '## Certificates', '', '| Name | Valid until | Serial |', '|---|---|---|');
    for (const x of r.certificates) lines.push(`| ${cell(x.name)} | ${x.validTo || ''}${x.expired ? ' (expired)' : ''} | ${x.serial || ''} |`);
  }
  lines.push('', '## Findings', '');
  if (!r.issues.length) lines.push('No problems found.');
  for (const i of r.issues) lines.push(`- **${i.level}** \`${i.path}\`: ${i.message}${i.fix ? ` ${i.fix}` : ''}`);
  return lines.join('\n') + '\n';
}

module.exports = { check, kindOf, markdown, matchProfile, profileType };
