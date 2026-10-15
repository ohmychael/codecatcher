// Runs apps-script/Code.gs in a sandbox with mocked Gmail and Apps Script services.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const GS = path.join(__dirname, '..', 'apps-script', 'Code.gs');

const KEY = 'k_' + 'x'.repeat(38);
const src = fs.readFileSync(GS, 'utf8').replace('__ACCESS_KEY__', KEY);

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bytesOf = (s) => Array.from(Buffer.from(s, 'utf8')).map((b) => (b > 127 ? b - 256 : b)); // Java-style signed bytes

const now = Date.now();
const messages = {
  m1: { // multipart/alternative, base64url string data
    id: 'm1', internalDate: String(now - 60_000), snippet: 'Your verification code is 739205',
    payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: 'Your verification code' }, { name: 'From', value: '"High Desert Corporate Filings" <noreply@highdesert.example>' }],
      parts: [
        { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { data: b64url('Your verification code is 739205.\nIt expires in 10 minutes.') } },
        { mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }], body: { data: b64url('<p>Your verification code is <b>739205</b>.</p>') } },
      ] } },
  m2: { // html only, data as signed byte array (how some advanced-service builds return it)
    id: 'm2', internalDate: String(now - 30_000), snippet: '',
    payload: { mimeType: 'text/html', headers: [{ name: 'Subject', value: 'Sign in to Acme — código' }, { name: 'From', value: 'Acme <hello@acme.example>' }],
      body: { data: bytesOf('<h1>Sign in to Acme</h1><p>Enter this code:</p><div style="font-size:30px">QW4-8ZT</div><p>© 2026 Acme · 500 Howard Street, San Francisco, CA 94105</p>') } } },
  m3: { // newsletter, no code
    id: 'm3', internalDate: String(now - 10_000), snippet: 'Spring sale',
    payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Spring sale!' }, { name: 'From', value: 'Shop <news@shop.example>' }],
      body: { data: b64url('Use promo code SPRING2026 for 20% off.') } } },
  m4: { // Google Voice forwarded SMS
    id: 'm4', internalDate: String(now - 5_000), snippet: '',
    payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: 'New text message from (775) 555-0142' }, { name: 'From', value: '"(775) 555-0142" <17755550142.17025551234.abcd@txt.voice.google.com>' }],
      parts: [{ mimeType: 'text/plain', body: { data: b64url('Your High Desert verification code is 551028.\n\nGoogle LLC 1600 Amphitheatre Parkway, Mountain View CA 94043 USA') } },
              { mimeType: 'application/pdf', filename: 'x.pdf', body: { attachmentId: 'a1' } }] } },
};

let getCalls = 0, lastQuery = null;
const cacheStore = {};
const sandbox = {
  console,
  Gmail: { Users: {
    Messages: {
      list: (user, opts) => { lastQuery = opts; return { messages: Object.keys(messages).map((id) => ({ id, threadId: id })) }; },
      get: (user, id) => { getCalls++; return JSON.parse(JSON.stringify(messages[id])); },
    },
    getProfile: () => ({ emailAddress: 'inbox.one@example.com' }),
  } },
  Utilities: {
    base64DecodeWebSafe: (s) => { if (s.length % 4) throw new Error('bad padding'); return bytesOf(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); },
    newBlob: (bytes) => ({ getDataAsString: (cs) => { if (cs && !/^utf-?8$/i.test(cs)) throw new Error('charset ' + cs); return Buffer.from(bytes.map((b) => (b < 0 ? b + 256 : b))).toString('utf8'); } }),
  },
  CacheService: { getScriptCache: () => ({
    get: (k) => cacheStore[k] || null,
    put: (k, v) => { cacheStore[k] = v; },
    getAll: (ks) => Object.fromEntries(ks.filter((k) => k in cacheStore).map((k) => [k, cacheStore[k]])),
    putAll: (o) => Object.assign(cacheStore, o),
  }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ body: s, setMimeType() { return this; } }) },
  Logger: { log: (s) => console.log('  [log]', s) },
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

let fails = 0;
const check = (label, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label} ${extra}`); if (!cond) fails++; };

// 1) wrong / missing key
let r = JSON.parse(sandbox.doGet({ parameter: { key: 'nope' } }).body);
check('rejects wrong key', r.ok === false && r.error === 'unauthorized');
r = JSON.parse(sandbox.doGet({ parameter: {} }).body);
check('rejects missing key', r.ok === false);

// 2) good key
r = JSON.parse(sandbox.doGet({ parameter: { key: KEY, minutes: '20' } }).body);
check('ok response', r.ok === true, JSON.stringify({ account: r.account, n: r.codes && r.codes.length }));
check('account email', r.account === 'inbox.one@example.com');
check('query uses epoch after:', /^after:\d{10} -in:sent -in:drafts$/.test(lastQuery.q) && lastQuery.includeSpamTrash === true, lastQuery.q);
const codes = r.codes.map((c) => c.code);
check('finds 3 codes, newest first', JSON.stringify(codes) === JSON.stringify(['551028', 'QW4-8ZT', '739205']), JSON.stringify(codes));
const sms = r.codes.find((c) => c.code === '551028');
check('google voice labelled as text', sms.sms === true && sms.fromName === 'Text from (775) 555-0142', sms.fromName);
const hd = r.codes.find((c) => c.code === '739205');
check('sender parsed', hd.fromName === 'High Desert Corporate Filings' && hd.fromEmail === 'noreply@highdesert.example');
check('no body text leaks beyond short context', r.codes.every((c) => (c.context || '').length <= 120));

// 3) cache: second call should not re-fetch messages
const before = getCalls;
JSON.parse(sandbox.doGet({ parameter: { key: KEY } }).body);
check('second poll served from cache', getCalls === before, `gets: ${before} -> ${getCalls}`);

// 4) the Run-menu helper works
sandbox.testCodeCatcher();

// 5) placeholder key refuses everything
const sandbox2 = { ...sandbox };
vm.createContext(sandbox2);
vm.runInContext(fs.readFileSync(GS, 'utf8'), sandbox2);
r = JSON.parse(sandbox2.doGet({ parameter: { key: '__ACCESS_KEY__' } }).body);
check('unconfigured script refuses', r.ok === false);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
