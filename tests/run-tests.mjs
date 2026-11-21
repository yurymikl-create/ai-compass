#!/usr/bin/env node
/*
 * AI Compass test suite - no dependencies, no build step required.
 *
 *   node tests/run-tests.mjs            # static + browser functional tests
 *   node tests/run-tests.mjs --keep      # keep the temp fixture dir for debugging
 *   node tests/run-tests.mjs --no-browser # static + data checks only (no Chrome needed)
 *   node tests/run-tests.mjs --page=news.html  # dump a single page while debugging
 *   node tests/run-tests.mjs --chrome-timeout=60000  # per-page Chrome budget (default 90s;
 *     the CI runner is ~2 cores and needs >30s for index.html alone)
 *
 * Steps:
 *   1. static analysis of every *.html (ids, links, orphan pages, inline JS syntax, markup balance)
 *   2. catalog data-model checks on index.html `services`
 *   3. news.json + rankings.json + fetch_news.py checks
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
const CHROME_TIMEOUT = Number((ARGS.find((a) => a.startsWith('--chrome-timeout=')) || '').split('=')[1] || 90000);
const KNOWN_FLAGS = ['--keep', '--no-browser'];
const UNKNOWN_FLAGS = ARGS.filter((a) => !KNOWN_FLAGS.includes(a) && !a.startsWith('--page=') && !a.startsWith('--chrome-timeout='));
if (UNKNOWN_FLAGS.length) console.log(`note: ignoring unknown flag(s): ${UNKNOWN_FLAGS.join(', ')}`);

const PAGES = ['index.html', 'news.html', 'data-tools.html', 'recommendations.html', 'requirements.html', 'rankings.html', 'mask.html'];
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

/* ------------------------------------------------------------------- i18n */
function i18nTests() {
  const g = 'static:i18n';
  const BILINGUAL = ['index.html', 'news.html', 'data-tools.html', 'recommendations.html', 'rankings.html', 'mask.html', 'requirements.html'];
  const sources = {};
  BILINGUAL.forEach((p) => {
    const file = path.join(ROOT, p);
    if (existsSync(file)) sources[p] = readFileSync(file, 'utf8');
  });

  // no page may fall back to Russian when nothing is stored
  const ruFallback = Object.entries(sources)
    .filter(([, src]) => /\|\|\s*'ru'/.test(src) || /===\s*'en'\s*\?\s*'en'\s*:\s*'ru'/.test(src))
    .map(([p]) => p);
  ok(g, 'no page falls back to Russian', ruFallback.length === 0, ruFallback.join(', ') || 'every page defaults to English');

  // the EN control must already carry the active state in the markup
  const notActive = Object.entries(sources).filter(([, src]) => {
    const enActive = /class="lang-btn active" data-lang="en"/.test(src) || /id="btn-en"[^>]*class="active"/.test(src) || /class="active"[^>]*id="btn-en"/.test(src);
    return !enActive;
  }).map(([p]) => p);
  ok(g, 'the EN control is active in the markup', notActive.length === 0, notActive.join(', ') || 'EN active on all ' + Object.keys(sources).length + ' pages');

  // and every Russian block must ship hidden, so the first paint is English.
  // Checked per tag: the style attribute may sit before or after the class one.
  const ruVisible = Object.entries(sources).filter(([, src]) => {
    const tags = src.match(/<[a-zA-Z][^>]*>/g) || [];
    return tags.some((tag) => /class="[^"]*lang-ru[^"]*"/.test(tag) && !/display:\s*none/.test(tag));
  }).map(([p]) => p);
  ok(g, 'no Russian block ships visible', ruVisible.length === 0, ruVisible.join(', ') || 'all RU blocks hidden in the markup');

  // the switcher has to exist on every bilingual page
  const noSwitcher = BILINGUAL.filter((p) => sources[p] && !/function switchLang\(|function applyLanguage\(/.test(sources[p]));
  ok(g, 'every page has a language switcher', noSwitcher.length === 0, noSwitcher.join(', ') || 'switchLang() / applyLanguage() present everywhere');

  const titles = Object.entries(sources)
    .filter(([, src]) => { const m = src.match(/<title>([^<]*)<\/title>/); return m && /[\u0400-\u04FF]/.test(m[1]); })
    .map(([p]) => p);
  ok(g, 'page titles start in English', titles.length === 0, titles.join(', ') || 'no Cyrillic in the default titles');
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

/* ------------------------------------------------------------- rankings.json */
function rankingsDataTests() {
  const g = 'static:rankings-json';
  const file = path.join(ROOT, 'rankings.json');
  if (!existsSync(file)) { ok(g, 'rankings.json exists', false); return; }
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { ok(g, 'rankings.json parses', false, e.message); return; }
  const list = data.sources || [];
  ok(g, 'rankings.json parses', true, list.length + ' sources');

  const required = ['id', 'name', 'section', 'axis', 'url', 'purpose_en', 'purpose_ru', 'checked_at', 'check_status'];
  const problems = [];
  list.forEach((s) => {
    required.forEach((k) => { if (!s[k]) problems.push(`${s.name || s.id}: missing ${k}`); });
    if (!Array.isArray(s.limitations_en) || s.limitations_en.length < 2) problems.push(`${s.name}: fewer than 2 EN limitations`);
    if (!Array.isArray(s.limitations_ru) || s.limitations_ru.length !== (s.limitations_en || []).length) problems.push(`${s.name}: RU and EN limitation counts differ`);
    if (!/^https:\/\//.test(s.url || '')) problems.push(`${s.name}: url is not https -> ${s.url}`);
    if (!['ok', 'blocked'].includes(s.check_status)) problems.push(`${s.name}: unknown check_status "${s.check_status}"`);
    if (typeof s.claims_verified !== 'boolean') problems.push(`${s.name}: claims_verified must be boolean`);
    if (s.check_status === 'blocked' && s.claims_verified === true) problems.push(`${s.name}: blocked source claims verified content`);
    ['score', 'rank', 'aa_score', 'arena_elo', 'rating'].forEach((k) => {
      if (s[k] !== undefined) problems.push(`${s.name}: rankings.json must not carry ${k}`);
    });
  });
  ok(g, 'every source is complete and honest', problems.length === 0, problems.slice(0, 5).join('; ') || `${list.length} sources ok`);
  const perSection = ['models', 'tools'].map((sec) => `${sec}=${list.filter((s) => s.section === sec).length}`);
  ok(g, 'both sections have sources', ['models', 'tools'].every((sec) => list.some((s) => s.section === sec)), perSection.join(', '));
  const dupes = list.map((s) => s.id).filter((id, i, a) => a.indexOf(id) !== i);
  ok(g, 'source ids unique', dupes.length === 0, dupes.join(', ') || 'ok');
  ok(g, 'checked_at is not in the future', !list.some((s) => new Date(s.checked_at) > new Date(Date.now() + 86400000)),
    list.filter((s) => new Date(s.checked_at) > new Date(Date.now() + 86400000)).map((s) => `${s.name}=${s.checked_at}`).join(', ') || 'ok');
  ok(g, 'all three axes are explained', (data.meta && data.meta.axes || []).length === 3, (data.meta && data.meta.axes || []).map((a) => a.id).join(', '));
  ok(g, 'meta.auto_update is false', !!(data.meta && data.meta.auto_update === false), data.meta ? `auto_update=${data.meta.auto_update}` : 'no meta block');
  const touching = ['.github/workflows/tests.yml', '.github/workflows/update-news.yml']
    .filter((w) => existsSync(path.join(ROOT, w)))
    .filter((w) => readFileSync(path.join(ROOT, w), 'utf8').includes('rankings'));
  ok(g, 'no workflow writes rankings.json', touching.length === 0, touching.join(', ') || 'nothing schedules the rankings data');
  const age = (Date.now() - new Date(String((data.meta || {}).last_review || '1970-01-01')).getTime()) / 86400000;
  warn(g, 'reviewed within 180 days', age < 180, `meta.last_review is ${age.toFixed(0)} days old (this file is reviewed by hand, not refreshed)`);
}

/* ------------------------------------------------- rankings feed + candidates */
function rankingsFeedTests() {
  const g = 'static:rankings-feed';
  const CATS = {
    model: ['chat', 'open', 'search'],
    tool: ['image', 'video', 'audio', 'code', 'productivity', 'research'],
    aggregator: ['api', 'chat', 'studio', 'hub']
  };

  const kbFile = path.join(ROOT, 'catalog-candidates.json');
  if (!existsSync(kbFile)) { ok(g, 'catalog-candidates.json exists', false, 'the auto-add knowledge base is missing'); }
  else {
    let kb = null;
    try { kb = JSON.parse(readFileSync(kbFile, 'utf8')); ok(g, 'catalog-candidates.json parses', true); }
    catch (e) { ok(g, 'catalog-candidates.json parses', false, e.message); }
    const list = (kb && kb.candidates) || [];
    ok(g, 'candidates knowledge base is populated', list.length > 0, list.length + ' candidates');
    const problems = [];
    list.forEach((c) => {
      ['name', 'type', 'category', 'access_level', 'desc_en', 'desc_ru', 'url', 'developer', 'developer_country']
        .forEach((k) => { if (!c[k]) problems.push(`${c.name || '?'}: missing ${k}`); });
      if (!/^https:\/\//.test(c.url || '')) problems.push(`${c.name}: url is not https`);
      if (!Array.isArray(c.aliases) || c.aliases.length === 0) problems.push(`${c.name}: no aliases`);
      if (!(CATS[c.type] || []).includes(c.category)) problems.push(`${c.name}: bad category ${c.category}/${c.type}`);
      if ((c.desc_en || '').length < 20 || (c.desc_ru || '').length < 20) problems.push(`${c.name}: description too short`);
      if (c.access_level === 'blocked' && c.vpn !== true) problems.push(`${c.name}: blocked must set vpn:true`);
    });
    ok(g, 'every candidate is complete and honest', problems.length === 0, problems.slice(0, 4).join('; ') || `${list.length} candidates ok`);
  }

  const feedFile = path.join(ROOT, 'rankings-feed.json');
  if (!existsSync(feedFile)) { ok(g, 'rankings-feed.json exists', false, 'run fetch_rankings.py'); return; }
  let feed;
  try { feed = JSON.parse(readFileSync(feedFile, 'utf8')); }
  catch (e) { ok(g, 'rankings-feed.json parses', false, e.message); return; }
  ok(g, 'rankings-feed.json parses', true, `${(feed.top || []).length} top rows, ${(feed.candidates || []).length} candidates`);
  ok(g, 'feed has last_updated', !!feed.last_updated, feed.last_updated);
  ok(g, 'top list is populated', Array.isArray(feed.top) && feed.top.length > 0, (feed.top || []).length + ' rows');
  const badCand = (feed.candidates || []).filter((c) => !c.name || !/^https:\/\//.test(c.url || ''));
  ok(g, 'every candidate has a name and https url', badCand.length === 0,
    badCand.slice(0, 3).map((c) => c.name).join(', ') || (feed.candidates || []).length + ' candidates ok');
  const dupes = (feed.candidates || []).map((c) => c.name).filter((n, i, a) => a.indexOf(n) !== i);
  ok(g, 'candidates are unique', dupes.length === 0, dupes.join(', ') || 'ok');
  const age = (Date.now() - new Date(String(feed.last_updated).replace(' ', 'T')).getTime()) / 86400000;
  warn(g, 'rankings feed refreshed within 14 days', age < 14, `last_updated is ${age.toFixed(1)} days old`);
}

/* ------------------------------------------- news launch review candidates */
function newsCandidatesTests() {
  const g = 'static:news-candidates';
  const file = path.join(ROOT, 'news-candidates.json');
  if (!existsSync(file)) {
    info(g, 'news-candidates.json exists', 'not generated yet - run detect_news_candidates.py');
    return;
  }
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { ok(g, 'news-candidates.json parses', false, e.message); return; }
  ok(g, 'news-candidates.json parses', true, `${(data.candidates || []).length} candidates`);
  ok(g, 'last_updated present', !!data.last_updated, data.last_updated);
  ok(g, 'candidates is an array', Array.isArray(data.candidates), Array.isArray(data.candidates) ? 'ok' : typeof data.candidates);

  const rows = Array.isArray(data.candidates) ? data.candidates : [];
  const problems = [];
  rows.forEach((c) => {
    if (!c.vendor) problems.push('missing vendor');
    if (!c.headline) problems.push('missing headline');
    if (!/^https:\/\//.test(String(c.url || ''))) problems.push(`bad url: ${c.url}`);
  });
  ok(g, 'every candidate has vendor, headline and https url', problems.length === 0, problems.slice(0, 4).join('; ') || `${rows.length} rows ok`);

  const urls = rows.map((c) => c.url);
  ok(g, 'candidate urls are unique', new Set(urls).size === urls.length, `${new Set(urls).size}/${urls.length} unique`);

  const placeholders = rows.filter((c) => /example\.(com|org)/i.test(String(c.url || '')));
  ok(g, 'no placeholder urls in review list', placeholders.length === 0, placeholders.length ? placeholders.map((c) => c.url).join(', ') : 'looks real');

  // The review list is allowed to be empty (no launches in the current feed).
  info(g, 'review list size', `${rows.length} launch headline(s) awaiting human review`);
}

/* ------------------------------------------------------- lifecycle status */
function statusTests() {
  const g = 'static:status';
  const STATES = ['ok', 'moved', 'deprecated', 'shutdown', 'inactive', 'unverified'];
  const STALE = ['deprecated', 'shutdown', 'inactive'];
  const file = path.join(ROOT, 'status.json');
  const overridesFile = path.join(ROOT, 'status-overrides.json');

  // catalog names, so status.json cannot drift away from index.html
  let catalogNames = [];
  try {
    const src = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const marker = 'const services = [';
    const start = src.indexOf(marker);
    const end = src.indexOf('\n        ];', start);
    catalogNames = new Function('return ' + src.slice(start + marker.length - 1, end + 10))().map((s) => s.name);
  } catch (e) {
    add(g, 'catalog readable for status checks', 'fail', e.message);
  }

  if (!existsSync(file)) {
    add(g, 'status.json exists', 'warn', 'run python3 check_status.py to generate it');
  } else {
    let data = null;
    try { data = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { add(g, 'status.json parses', 'fail', e.message); }
    if (data) {
      const services = data.services || {};
      const names = Object.keys(services);
      ok(g, 'status.json parses', names.length > 0, names.length + ' records');
      ok(g, 'status.json records a generation time', !!data.generated_at, data.generated_at || 'missing generated_at');
      const age = data.generated_at ? (Date.now() - new Date(data.generated_at).getTime()) / 86400000 : NaN;
      warn(g, 'status.json is fresh', age <= 7, isNaN(age) ? 'generated_at unreadable' : age.toFixed(1) + ' days old');

      const badStates = names.filter((n) => STATES.indexOf(services[n].state) === -1);
      ok(g, 'every status is a known lifecycle state', badStates.length === 0, badStates.slice(0, 5).join(', ') || names.length + ' records');

      const orphans = names.filter((n) => catalogNames.indexOf(n) === -1);
      ok(g, 'status.json only lists catalogued services', orphans.length === 0, orphans.slice(0, 5).join(', ') || 'ok');

      const missing = catalogNames.filter((n) => names.indexOf(n) === -1);
      warn(g, 'every catalogued service has a status record', missing.length === 0,
        missing.length ? missing.slice(0, 5).join(', ') + ' (' + missing.length + ' missing)' : 'ok');

      const stale = names.filter((n) => STALE.indexOf(services[n].state) !== -1);
      const noNote = stale.filter((n) => !services[n].note_en || !services[n].note_ru);
      ok(g, 'outdated services explain themselves in both languages', noNote.length === 0,
        noNote.slice(0, 5).join(', ') || stale.length + ' outdated records');

      // the two axes must stay separate: lifecycle here, Belarus availability in index.html
      const leaks = names.filter((n) => services[n].access_level !== undefined || services[n].vpn !== undefined);
      ok(g, 'status.json never rewrites access_level or vpn', leaks.length === 0, leaks.slice(0, 5).join(', ') || 'lifecycle only');
      info(g, 'lifecycle states in the feed', [...new Set(names.map((n) => services[n].state))].join(', '));
    }
  }

  if (!existsSync(overridesFile)) {
    add(g, 'status-overrides.json exists', 'warn', 'manual overrides file is missing');
  } else {
    let ov = null;
    try { ov = JSON.parse(readFileSync(overridesFile, 'utf8')); }
    catch (e) { add(g, 'status-overrides.json parses', 'fail', e.message); }
    if (ov) {
      const list = ov.overrides || {};
      const names = Object.keys(list);
      ok(g, 'status-overrides.json parses', true, names.length + ' manual overrides');
      const bad = names.filter((n) => !list[n] || STATES.indexOf(list[n].state) === -1);
      ok(g, 'every override uses a known state', bad.length === 0, bad.join(', ') || 'ok');
      const unknown = names.filter((n) => catalogNames.indexOf(n) === -1);
      ok(g, 'every override points at a catalogued service', unknown.length === 0, unknown.join(', ') || 'ok');
      const noNote = names.filter((n) => !list[n].note_en || !list[n].note_ru);
      ok(g, 'every override explains itself in both languages', noNote.length === 0, noNote.join(', ') || 'ok');
    }
  }

  ['check_status.py', 'fetch_rankings.py'].forEach((script) => {
    if (!existsSync(path.join(ROOT, script))) { ok(g, script + ' exists', false); return; }
    const comp = spawnSync('python3', ['-m', 'py_compile', script], { cwd: ROOT, encoding: 'utf8' });
    ok(g, script + ' compiles', comp.status === 0, ((comp.stderr || '').trim().split('\n').slice(-2).join(' ')) || 'ok');
  });

  // A redirect to a sign-in page is not a move: the product did not go anywhere.
  // Shedevrum -> passport.yandex.ru used to be reported as "Переехал" (a false alarm).
  if (existsSync(path.join(ROOT, 'check_status.py'))) {
    const src = readFileSync(path.join(ROOT, 'check_status.py'), 'utf8');
    ok(g, 'check_status.py recognises login redirects', /AUTH_HOST_PREFIXES/.test(src) && /is_auth_host/.test(src),
      'auth-host guard present');
    const probe = spawnSync('python3', ['-c',
      'import check_status as c;'
      + 'print(c.is_auth_host("passport.yandex.ru"), c.is_auth_host("chatgpt.com"), c.is_auth_host("aistudio.yandex.ru"))'],
      { cwd: ROOT, encoding: 'utf8' });
    const out = (probe.stdout || '').trim();
    ok(g, 'login pages are not mistaken for moves', out === 'True False False',
      out || ((probe.stderr || '').trim().split('\n').slice(-1)[0] || 'no output'));
  }

  const checker = existsSync(path.join(ROOT, 'check_status.py')) ? readFileSync(path.join(ROOT, 'check_status.py'), 'utf8') : '';
  ok(g, 'check_status.py never writes access_level or vpn',
    !/["']access_level["']\s*:/.test(checker) && !/["']vpn["']\s*:/.test(checker),
    'the lifecycle probe must not overwrite the Belarus-availability fields');
  ok(g, 'check_status.py needs two failures before marking a service inactive',
    /FAIL_THRESHOLD\s*=\s*2/.test(checker), 'two-strike rule present');

  // behaviour of the two-strike rule, without network access
  const behaviour = spawnSync('python3', ['-c',
    'import check_status as c; print(c.resolve_state("dead", 1)[0], c.resolve_state("dead", 2)[0], c.resolve_state("forbidden", 2)[0], c.resolve_state("ok", 3)[0])'
  ], { cwd: ROOT, encoding: 'utf8' });
  const got = (behaviour.stdout || '').trim();
  ok(g, 'one failure stays unverified, two become inactive', got === 'unverified inactive unverified ok',
    got || (behaviour.stderr || '').trim());

  const workflow = path.join(ROOT, '.github', 'workflows', 'check-status.yml');
  ok(g, 'check-status workflow exists', existsSync(workflow));
  if (existsSync(workflow)) {
    const yml = readFileSync(workflow, 'utf8');
    ok(g, 'check-status workflow runs on a schedule and commits status.json',
      /cron:/.test(yml) && /workflow_dispatch/.test(yml) && /check_status\.py/.test(yml) && /status\.json/.test(yml),
      'cron + dispatch + check_status.py + status.json');
  }
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
const ERR_HOOK = '<script>try{localStorage.clear();}catch(e){}window.__errs=[];window.addEventListener("error",function(e){window.__errs.push(e.message+" @ "+(e.filename||"")+":"+e.lineno);},true);</script>';

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
  if (existsSync(path.join(ROOT, 'rankings.json'))) cpSync(path.join(ROOT, 'rankings.json'), path.join(dir, 'rankings.json'));
  // the lifecycle feed is optional for the page, but the real file must be served in the
  // fixture so the status chip and the badges are exercised against real data
  if (existsSync(path.join(ROOT, 'status.json'))) cpSync(path.join(ROOT, 'status.json'), path.join(dir, 'status.json'));
  if (existsSync(path.join(ROOT, 'status-overrides.json'))) cpSync(path.join(ROOT, 'status-overrides.json'), path.join(dir, 'status-overrides.json'));
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
  const list = ['/', '/index.html', '/news.html', '/data-tools.html', '/recommendations.html', '/requirements.html', '/rankings.html', '/news.json', '/rankings.json', '/status.json', '/app-harness.js'];
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
    i18nTests();
    dataTests();
    newsDataTests();
    rankingsDataTests();
    rankingsFeedTests();
    newsCandidatesTests();
    statusTests();
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



