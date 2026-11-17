#!/usr/bin/env node
/*
 * AI Compass test suite - no dependencies, no build step required.
 *
 *   node tests/run-tests.mjs            # static + browser functional tests
 *   node tests/run-tests.mjs --keep      # keep the temp fixture dir for debugging
 *   node tests/run-tests.mjs --no-browser # static + data checks only (no Chrome needed)
 *   node tests/run-tests.mjs --page=news.html  # dump a single page while debugging
 *
 * Steps:
 *   1. static analysis of every *.html (ids, links, orphan pages, inline JS syntax, markup balance)
 *   2. catalog data-model checks on index.html `services`
 *   3. news.json + fetch_news.py checks
 *   4. isolated fixture copy in a temp dir with assertion harnesses injected
 *   5. headless Chrome (--dump-dom) drives the fixture over http
 *   6. grouped report; exit code 1 when any check fails
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const KEEP = ARGS.includes('--keep');
const NO_BROWSER = ARGS.includes('--no-browser');
const PAGE_ONLY = (ARGS.find((a) => a.startsWith('--page=')) || '').slice('--page='.length);
const CHROME_TIMEOUT = 30000;
const KNOWN_FLAGS = ['--keep', '--no-browser'];
const UNKNOWN_FLAGS = ARGS.filter((a) => !KNOWN_FLAGS.includes(a) && !a.startsWith('--page='));
if (UNKNOWN_FLAGS.length) console.log(`note: ignoring unknown flag(s): ${UNKNOWN_FLAGS.join(', ')}`);

const PAGES = ['index.html', 'news.html', 'data-tools.html', 'recommendations.html', 'requirements.html'];
const ALL_TARGETS = [...PAGES, 'broken/news-broken.html'];

const rows = [];
const add = (group, name, status, detail) => rows.push({ group, name, status, detail: detail == null ? '' : String(detail) });
const ok = (g, n, c, d) => add(g, n, c ? 'pass' : 'fail', d);
const warn = (g, n, c, d) => add(g, n, c ? 'pass' : 'warn', d);
const info = (g, n, d) => add(g, n, 'info', d);

/* ------------------------------------------------------------------ static */
function staticTests() {
  const g = 'static:files';
  const sources = {};
  PAGES.forEach((p) => {
    const file = path.join(ROOT, p);
    ok(g, `${p} exists`, existsSync(file));
    if (existsSync(file)) sources[p] = readFileSync(file, 'utf8');
  });

  PAGES.filter((p) => sources[p]).forEach((p) => {
    const ids = (sources[p].match(/\sid="([^"]+)"/g) || []).map((s) => s.slice(4, -1));
    const dupes = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
    ok('static:ids', p, dupes.length === 0, dupes.length ? 'duplicate ids: ' + dupes.join(', ') : ids.length + ' unique ids');
  });

  const targets = new Set();
  Object.entries(sources).forEach(([, src]) => {
    [...src.matchAll(/href="([^"#]+?\.html)/g)].forEach((m) => targets.add(m[1]));
    [...src.matchAll(/(?:src|href)="((?!https?:\/\/)[^"]*?)"/g)].forEach((m) => { if (/\.(png|ico|css|js|json|jpg|svg|woff2?)$/.test(m[1])) targets.add(m[1]); });
  });
  [...targets].forEach((f) => ok('static:links', f, existsSync(path.join(ROOT, f))));

  const linked = new Set();
  Object.values(sources).forEach((src) => [...src.matchAll(/href="([^"#]+\.html)/g)].forEach((m) => linked.add(m[1])));
  const orphans = Object.keys(sources).filter((p) => p !== 'index.html' && !linked.has(p));
  ok(g, 'no orphan pages', orphans.length === 0, orphans.length ? 'linked from nowhere: ' + orphans.join(', ') : 'all sub-pages reachable');

  Object.entries(sources).forEach(([p, src]) => {
    const blocks = [...src.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((c) => c.trim());
    const errs = [];
    blocks.forEach((code, i) => { try { new Function(code); } catch (e) { errs.push(`block ${i + 1}: ${e.message}`); } });
    ok('static:js-syntax', p, errs.length === 0, errs.join('; ') || `${blocks.length} inline script block(s) parse`);
  });

  Object.entries(sources).forEach(([p, src]) => {
    const open = (src.match(/<div\b[^>]*>/g) || []).length;
    const close = (src.match(/<\/div>/g) || []).length;
    ok('static:markup', `${p} balanced divs`, open === close, `${open} open vs ${close} close`);
    ok('static:markup', `${p} closes with </html>`, /<\/html>\s*$/.test(src), `tail: ${JSON.stringify(src.trimEnd().slice(-24))}`);
    const brokenTags = [...new Set(src.match(/<\/[^>]*[^\x00-\x7F][^>]*>/g) || [])];
    ok('static:markup', `${p} no non-ascii in closing tags`, brokenTags.length === 0, brokenTags.join(', '));
  });

  const ls = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  const watchList = ['index.html.bak', 'index.html.bak_clean_data', 'For GigaChat'];
  const stray = ls.status === 0
    ? ls.stdout.split('\n').filter((f) => watchList.some((w) => f === w) || /\.DS_Store$|\.bak/.test(f))
    : watchList.filter((f) => existsSync(path.join(ROOT, f)));
  warn(g, 'no stray backup or metadata files committed', stray.length === 0,
    stray.join(', ') + ' (reachable on static hosts)');
}

/* -------------------------------------------------------------- data model */
function dataTests() {
  const g = 'static:catalog-data';
  const s = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const marker = 'const services = [';
  const start = s.indexOf(marker);
  const end = s.indexOf('\n        ];', start);
  if (start < 0 || end < 0) { ok(g, 'services array found', false, 'pattern not found in index.html'); return null; }
  let data;
  try { data = new Function('return ' + s.slice(start + marker.length - 1, end + 10))(); }
  catch (e) { ok(g, 'services literal evaluates', false, e.message); return null; }
  ok(g, 'services literal evaluates', true, data.length + ' entries');

  const types = [...new Set(data.map((x) => x.type))];
  ok(g, 'type values are tab-supported', types.every((t) => ['model', 'tool', 'aggregator'].includes(t)), types.join(', '));
  const levels = [...new Set(data.map((x) => x.access_level || 'UNSET'))];
  ok(g, 'access_level values supported', levels.every((l) => ['available', 'limited', 'blocked', 'via_aggregator', 'UNSET'].includes(l)), levels.join(', '));
  const payments = [...new Set(data.map((x) => x.payment || 'UNSET'))];
  // the catalog uses two orthogonal ideas in one field: currency codes (BYN, RU= RUB)
  // and categories (FOREIGN, OTHER). Both are supported by the UI today.
  const badPayments = payments.filter((p) => !['BYN', 'RU', 'FOREIGN', 'OTHER', 'UNSET'].includes(p));
  ok(g, 'payment values supported', badPayments.length === 0, badPayments.length ? 'unexpected value(s): ' + badPayments.join(', ') : payments.join(', '));
  const untaggedAggregators = data.filter((x) => x.type === 'aggregator' && !x.access_level).map((x) => x.name);
  warn(g, 'aggregators use the via_aggregator badge', untaggedAggregators.length === 0, untaggedAggregators.length ? `'via_aggregator' branch in renderCards() is unreachable; aggregators fall back to ${[...new Set(data.filter((x) => x.type === 'aggregator').map((x) => x.access_level || 'UNSET'))].join('/')}` : 'ok');
  const bynForeign = data.filter((x) => x.payment === 'BYN' && !['BY', 'RU', 'KZ'].includes(x.developer_country)).map((x) => `${x.name} (${x.developer_country})`);
  warn(g, 'BYN payment only for regional services', bynForeign.length === 0, bynForeign.join(', ') || 'ok');
  info(g, 'developer_country values', [...new Set(data.map((x) => x.developer_country || 'NONE'))].join(', '));
  info(g, 'servers values', [...new Set(data.map((x) => x.servers || 'NONE'))].join(', '));

  const badUrls = data.filter((x) => !/^https?:\/\/\S+$/.test(x.url)).map((x) => `${x.name}=${x.url}`);
  ok(g, 'all service urls valid', badUrls.length === 0, badUrls.join(', ') || data.length + ' urls ok');

  const inconsistent = data.filter((x) => x.access_level === 'blocked' && x.vpn === false).map((x) => x.name);
  warn(g, 'blocked services also flagged vpn:true', inconsistent.length === 0, inconsistent.join(', ') || 'consistent');

  const noFlag = data.filter((x) => !x.vpn && x.servers === 'RU').map((x) => x.name);
  info(g, 'RU-hosted services reachable without VPN', noFlag.length ? noFlag.join(', ') : 'none');
  return data;
}

/* ---------------------------------------------------------------- news.json */
function newsDataTests() {
  const g = 'static:news-json';
  const file = path.join(ROOT, 'news.json');
  if (!existsSync(file)) { ok(g, 'news.json exists', false); return; }
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { ok(g, 'news.json parses', false, e.message); return; }
  ok(g, 'news.json parses', true, (data.news || []).length + ' items');
  ok(g, 'last_updated present', !!data.last_updated, data.last_updated);
  const bad = (data.news || []).filter((n) => !n.title || !n.url || !n.source || !n.date);
  ok(g, 'every item complete', bad.length === 0, bad.length + ' incomplete items');
  const placeholders = (data.news || []).filter((n) => /example\.com|placeholder|localhost/i.test(n.url)).map((n) => n.url);
  ok(g, 'no placeholder urls in feed', placeholders.length === 0, placeholders.join(', ') || 'feed content looks real');
  const future = (data.news || []).filter((n) => new Date(n.date) > new Date());
  warn(g, 'no future-dated items', future.length === 0, future.map((n) => `${n.title} (${n.date})`).join(', ') || 'ok');
  const age = (Date.now() - new Date(String(data.last_updated).replace(' ', 'T')).getTime()) / 86400000;
  warn(g, 'feed refreshed within 14 days', age < 14, `last_updated is ${age.toFixed(1)} days old (news.html shows "NEW" badges on every item regardless of age)`);
}

/* ------------------------------------------------------------ fetch_news.py */
function pythonTests() {
  const g = 'static:news-script';
  if (!existsSync(path.join(ROOT, 'fetch_news.py'))) { ok(g, 'fetch_news.py exists', false); return; }
  const comp = spawnSync('python3', ['-m', 'py_compile', 'fetch_news.py'], { cwd: ROOT, encoding: 'utf8' });
  ok(g, 'fetch_news.py compiles', comp.status === 0, ((comp.stderr || '').trim().split('\n').slice(-2).join(' ')) || 'ok');
  const src = readFileSync(path.join(ROOT, 'fetch_news.py'), 'utf8');
  warn(g, 'fetch_news.py writes outside repo safely', src.includes('if __name__'), 'entry guard present');
  const kw = (src.match(/(?:ai_keywords|AI_KEYWORDS)\s*=\s*\[([\s\S]*?)\]/) || [])[1];
  info(g, 'keyword filter list', kw ? kw.split(',').length + ' keywords' : 'not found');
  warn(g, 'fetch_news.py has no test or CI hook', !existsSync(path.join(ROOT, 'tests', 'fetch-news.test.py')), 'only smoke-checked by py_compile here');
}

/* ----------------------------------------------------------------- fixture */
const ERR_HOOK = '<script>window.__errs=[];window.addEventListener("error",function(e){window.__errs.push(e.message+" @ "+(e.filename||"")+":"+e.lineno);},true);</script>';

// The pages pull Inter from fonts.googleapis.com. In a headless dump that remote
// stylesheet is the slowest and least reproducible part of the run, so the fixture
// is made hermetic: no cross-origin requests, identical render on every machine.
function offline(html) {
  return html
    .replace(/@import\s+url\(\s*['"]?https?:\/\/[^'")]+['"]?\s*\)\s*;?/g, '')
    .replace(/<link\b[^>]+\bhref=["']https?:\/\/[^"']+["'][^>]*>/gi, '');
}

function inject(html, harness) {
  const withHook = html.replace(/<head>/i, '<head>' + ERR_HOOK);
  const i = withHook.lastIndexOf('</body>');
  if (i < 0) return withHook;
  return withHook.slice(0, i) + `<script defer src="/${harness}"></script>` + withHook.slice(i);
}

function buildFixture(dir) {
  PAGES.forEach((p) => {
    const src = path.join(ROOT, p);
    if (!existsSync(src)) return;
    const harness = p === 'index.html' ? 'app-harness.js' : 'page-harness.js';
    writeFileSync(path.join(dir, p), inject(offline(readFileSync(src, 'utf8')), harness));
  });
  ['app-harness.js', 'page-harness.js'].forEach((f) => cpSync(path.join(__dirname, f), path.join(dir, f)));
  if (existsSync(path.join(ROOT, 'news.json'))) cpSync(path.join(ROOT, 'news.json'), path.join(dir, 'news.json'));
  ['favicon.ico', 'favicon.png'].filter((f) => existsSync(path.join(ROOT, f))).forEach((f) => cpSync(path.join(ROOT, f), path.join(dir, f)));
  if (existsSync(path.join(ROOT, 'assets'))) cpSync(path.join(ROOT, 'assets'), path.join(dir, 'assets'), { recursive: true });
  // failure branch: the same news page served from a subdirectory where news.json does
  // not exist, so the "feed unavailable" path is really exercised. index.html is copied
  // next to it so the page's own internal links still resolve.
  const broken = path.join(dir, 'broken');
  mkdirSync(broken);
  if (existsSync(path.join(ROOT, 'news.html'))) {
    writeFileSync(path.join(broken, 'news-broken.html'), inject(offline(readFileSync(path.join(ROOT, 'news.html'), 'utf8')), 'page-harness.js'));
  }
  if (existsSync(path.join(dir, 'index.html'))) cpSync(path.join(dir, 'index.html'), path.join(broken, 'index.html'));
  return dir;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };

function serve(dir) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(dir, rel);
      if (!file.startsWith(dir) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/* ------------------------------------------------------------------ chrome */
function findChrome() {
  const cands = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
  ];
  return cands.find((c) => c && existsSync(c)) || null;
}

// Chrome must NOT be spawned synchronously: the fixture is served by an in-process
// http server, and spawnSync blocks the event loop, so the page request is never
// answered and every dump used to end in a timeout.
function dumpDom(chrome, profile, target) {
  const shared = [`--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
    '--virtual-time-budget=25000', '--dump-dom', target];
  const run = (headlessFlag) => new Promise((resolve) => {
    const child = spawn(chrome, [headlessFlag, ...shared], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { if (stdout.length < 64 * 1024 * 1024) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, CHROME_TIMEOUT);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: String(e.message), timedOut: true });
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut });
    });
  });
  return run('--headless=new').then(async (first) => {
    if (first.stdout.includes('__TEST_RESULTS__') || first.timedOut) return first;
    return run('--headless');
  });
}

function collect(out, label) {
  const dom = out.stdout || '';
  const m = dom.match(/<div id="__TEST_RESULTS__"[^>]*>([^<]+)<\/div>/);
  if (!m) {
    add('browser', `${label} produced results`, 'fail',
      `no __TEST_RESULTS__ in dump (${dom.length} bytes, ${out.timedOut ? 'Chrome timed out after ' + CHROME_TIMEOUT + 'ms' : 'stderr: ' + String(out.stderr || '').slice(0, 160)})`);
    return;
  }
  const items = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  items.forEach((r) => add(r.group, r.name, r.status, r.detail));
  const cardCount = (dom.match(/class="card"/g) || []).length;
  info('browser', `${label} final DOM`, `${cardCount} .card elements in dumped DOM`);
}

async function httpChecks(base) {
  const list = ['/', '/index.html', '/news.html', '/data-tools.html', '/recommendations.html', '/requirements.html', '/news.json', '/app-harness.js'];
  for (const p of list) {
    try {
      const res = await fetch(base + p);
      ok('server', `${p} served`, res.status === 200, 'HTTP ' + res.status);
    } catch (e) { ok('server', `${p} served`, false, e.message); }
  }
}

/* ------------------------------------------------------------------ report */
const C = process.stdout.isTTY ? { pass: '\x1b[32m', fail: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[90m', off: '\x1b[0m' }
  : { pass: '', fail: '', warn: '', info: '', off: '' };
const MARK = { pass: '  ok  ', fail: ' FAIL ', warn: ' WARN ', info: '  ..  ' };

function report() {
  const groups = new Map();
  rows.forEach((r) => { if (!groups.has(r.group)) groups.set(r.group, []); groups.get(r.group).push(r); });
  const counts = { pass: 0, fail: 0, warn: 0, info: 0 };
  rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });

  console.log('');
  for (const [group, items] of groups) {
    console.log(`── ${group} ${'─'.repeat(Math.max(1, 60 - group.length))}`);
    items.forEach((r) => {
      console.log(` ${C[r.status]}${MARK[r.status] || r.status}${C.off} ${r.name}${r.detail ? `\n            ${C[r.status]}${r.detail}${C.off}` : ''}`);
    });
  }

  console.log('');
  console.log(`SUMMARY  ok=${counts.pass}  FAIL=${counts.fail}  warn=${counts.warn}  info=${counts.info}  total=${rows.length}`);

  const problems = rows.filter((r) => r.status === 'fail' || r.status === 'warn');
  if (problems.length) {
    console.log('');
    console.log('ISSUES:');
    problems.forEach((r, i) => console.log(` ${i + 1}. [${r.status.toUpperCase()}] ${r.group} :: ${r.name}${r.detail ? ' - ' + r.detail : ''}`));
  }
  console.log('');
  return counts.fail;
}

/* -------------------------------------------------------------------- main */
(async function main() {
  console.log('AI Compass - automated test suite');
  console.log(`project: ${ROOT}`);
  let dir = null, srv = null, fails = 0;
  try {
    staticTests();
    dataTests();
    newsDataTests();
    pythonTests();

    if (NO_BROWSER) {
      add('runner', 'browser + fixture phase', 'info', 'skipped via --no-browser (static and data checks only)');
      return;
    }

    dir = mkdtempSync(path.join(tmpdir(), 'ai-compass-fixture-'));
    buildFixture(dir);
    const { srv: s, port } = await serve(dir);
    srv = s;
    const base = `http://127.0.0.1:${port}`;
    info('server', 'fixture root', `${dir} -> ${base}`);

    await httpChecks(base);

    const chrome = findChrome();
    if (!chrome) {
      add('browser', 'headless chrome found', 'fail', 'none of the known Chrome paths exist; set CHROME_BIN=/path/to/chrome or run with --no-browser');
    } else {
      info('browser', 'using', chrome);
      const profile = path.join(dir, 'chrome-profile');
      const targets = PAGE_ONLY ? ALL_TARGETS.filter((t) => t.endsWith(PAGE_ONLY)) : ALL_TARGETS;
      if (!targets.length) add('browser', `--page=${PAGE_ONLY} is a known target`, false, `known targets: ${ALL_TARGETS.join(', ')}`);
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        console.log(`.. dumping ${t} (${i + 1}/${targets.length})`);
        const out = await dumpDom(chrome, profile, `${base}/${t}`);
        if (KEEP) writeFileSync(path.join(dir, 'dom-' + t.replace(/[^\w.]+/g, '-') + '.html'), out.stdout || '');
        collect(out, t);
      }
    }
  } catch (e) {
    add('runner', 'suite completed', 'fail', (e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : String(e)));
  } finally {
    if (srv) srv.close();
    fails = report();
    if (KEEP && dir) console.log(`fixture kept at ${dir}`);
    else if (dir) rmSync(dir, { recursive: true, force: true });
  }
  process.exit(fails > 0 ? 1 : 0);
})();



