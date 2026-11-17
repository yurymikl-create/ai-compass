/*
 * Injected assertion harness for index.html (AI Compass catalog page).
 * Loaded by tests/run-tests.mjs as a classic deferred script, so it shares the
 * global scope with the inline app script and can read `services` / `renderCards`.
 * Results are emitted as base64-JSON inside <div id="__TEST_RESULTS__">.
 */
(function () {
  var R = [];
  function add(group, name, status, detail) {
    R.push({ group: group, name: name, status: status, detail: detail == null ? '' : String(detail) });
  }
  function ok(g, n, c, d) { add(g, n, c ? 'pass' : 'fail', d); }
  function warn(g, n, c, d) { add(g, n, c ? 'pass' : 'warn', d); }
  var CYR = /[\u0400-\u04FF]/;

  // App declares `const services` at top level -> global lexical binding (not a window prop).
  var DATA = null;
  try { DATA = eval('services'); } catch (e) { add('index:data', 'services global available', 'fail', e.message); }
  // renderCards is a function declaration -> real window property, so it can be wrapped to count calls.
  var renderCalls = 0;
  var nativeRender = window.renderCards;
  if (typeof nativeRender === 'function') {
    window.renderCards = function () { renderCalls++; return nativeRender.apply(this, arguments); };
  }

  function cards() { return Array.prototype.slice.call(document.querySelectorAll('#cards-container .card')); }
  function cardName(c) { var h = c.querySelector('h3'); return h ? h.textContent.trim() : ''; }
  function cardDesc(c) { var p = c.querySelector('p'); return p ? p.textContent.trim() : ''; }
  function names() { return cards().map(cardName); }
  function expectedOrder(list, key) {
    return list.slice().sort(function (a, b) {
      if (key === 'name') return a.name.localeCompare(b.name);
      return ((b[key] || 0) - (a[key] || 0));
    }).map(function (s) { return s.name; });
  }
  function clickTab(type) {
    var b = document.querySelector('.tab-btn[data-type="' + type + '"]');
    if (b) b.click();
    return !!b;
  }
  function setSort(value) {
    var sel = document.getElementById('sort-select');
    sel.value = value;
    sel.dispatchEvent(new Event('change'));
  }
  function setSearch(text) {
    var inp = document.getElementById('search-input');
    inp.value = text;
    inp.dispatchEvent(new Event('input'));
  }
  function visibleText(el) { return el && el.style.display !== 'none'; }

  function dataTests() {
    var g = 'index:data';
    if (!Array.isArray(DATA) || DATA.length === 0) {
      add(g, 'catalog data loaded', 'fail', 'services array missing or empty');
      return false;
    }
    ok(g, 'catalog data loaded', true, DATA.length + ' services');

    var TAB_TYPES = ['model', 'tool', 'aggregator'];
    var ACCESS = ['available', 'limited', 'blocked', 'via_aggregator'];
    var REQUIRED = ['name', 'type', 'access_level', 'url', 'developer', 'developer_country', 'desc_en', 'desc_ru', 'aa_score'];
    var bad = [];
    DATA.forEach(function (s) {
      REQUIRED.forEach(function (k) { if (s[k] === undefined) bad.push(s.name + ': missing ' + k); });
      if (s.type && TAB_TYPES.indexOf(s.type) === -1) bad.push(s.name + ': type "' + s.type + '" has no tab');
      if (s.access_level && ACCESS.indexOf(s.access_level) === -1) bad.push(s.name + ': unknown access_level "' + s.access_level + '"');
      if (s.url && !/^https?:\/\/[^\s]+$/.test(s.url)) bad.push(s.name + ': bad url ' + s.url);
      if (s.aa_score !== null && s.aa_score !== undefined && (typeof s.aa_score !== 'number' || s.aa_score < 0 || s.aa_score > 100)) bad.push(s.name + ': aa_score outside 0..100 -> ' + s.aa_score);
      if (!s.desc_en || s.desc_en.length < 30) bad.push(s.name + ': desc_en too short');
      if (!s.desc_ru || !CYR.test(s.desc_ru)) bad.push(s.name + ': desc_ru is not Russian');
      if (s.desc_en && CYR.test(s.desc_en)) bad.push(s.name + ': desc_en contains Cyrillic');
    });
    ok(g, 'every service has a valid schema', bad.length === 0, bad.slice(0, 6).join('; ') || 'all ' + DATA.length + ' rows ok');

    var dupes = DATA.map(function (s) { return s.name; }).filter(function (n, i, a) { return a.indexOf(n) !== i; });
    ok(g, 'service names unique', dupes.length === 0, dupes.join(', ') || 'no duplicates');

    var emptyTabs = TAB_TYPES.filter(function (t) { return !DATA.some(function (s) { return s.type === t; }); });
    var perTab = TAB_TYPES.map(function (t) { return t + '=' + DATA.filter(function (s) { return s.type === t; }).length; }).join(', ');
    ok(g, 'every tab has at least one service', emptyTabs.length === 0, emptyTabs.length ? 'empty tabs: ' + emptyTabs.join(', ') : perTab);

    var noAccess = DATA.filter(function (s) { return !s.access_level; }).map(function (s) { return s.name; });
    warn(g, 'access_level set on every service', noAccess.length === 0, noAccess.length ? 'falls back to vpn flag for: ' + noAccess.slice(0, 5).join(', ') : 'ok');

    var starRisk = DATA.filter(function (s) {
      return s.aa_score != null && (Math.round(s.aa_score / 60 * 5) > 5 || Math.round(s.aa_score / 60 * 5) < 0);
    });
    var maxScore = Math.max.apply(null, DATA.filter(function (s) { return s.aa_score != null; }).map(function (s) { return s.aa_score; }));
    ok(g, 'aa_score fits the 5-star formula', starRisk.length === 0, starRisk.length ? "'☆'.repeat(negative) throws for " + starRisk.map(function (s) { return s.name + '=' + s.aa_score; }).join(', ') : 'max aa_score = ' + maxScore);

    var unrated = DATA.filter(function (s) { return s.aa_score === null || s.aa_score === undefined; }).map(function (s) { return s.name; });
    add(g, 'services without a rating', 'info', unrated.length + ' -> badge/label hidden: ' + unrated.join(', '));
    return true;
  }

  function renderTests() {
    var g = 'index:render';
    var el = cards();
    ok(g, 'cards rendered on load', el.length > 0, el.length + ' cards, ' + DATA.length + ' services');
    ok(g, 'all services visible in "All" tab', el.length === DATA.length, 'missing ' + (DATA.length - el.length));

    var orphanCards = el.filter(function (c) { return !DATA.some(function (s) { return s.name === cardName(c); }); }).map(cardName);
    ok(g, 'cards map to known services', orphanCards.length === 0, orphanCards.join(', ') || 'ok');

    var noDesc = el.filter(function (c) { return cardDesc(c).length < 20; }).map(cardName);
    ok(g, 'every card has a description', noDesc.length === 0, noDesc.join(', ') || 'ok');

    var links = el.map(function (c) { return c.querySelector('a.card-link'); });
    var badLinks = links.filter(function (a) { return !a || !/^https?:\/\//.test(a.getAttribute('href') || ''); });
    ok(g, 'every card links to a service site', badLinks.length === 0, badLinks.length + ' broken links');
    var noTarget = links.filter(function (a) { return a && a.getAttribute('target') !== '_blank'; });
    warn(g, 'external links open in a new tab', noTarget.length === 0, noTarget.length + ' links without target=_blank');

    var noTags = el.filter(function (c) { var t = c.querySelector('.card-tags'); return !t || !t.textContent.trim(); }).map(cardName);
    ok(g, 'every card has status tags', noTags.length === 0, noTags.join(', ') || 'ok');

    var domOrder = names();
    var expOrder = expectedOrder(DATA, 'aa_score');
    ok(g, 'default sort is by AA score', domOrder.join('|') === expOrder.join('|'),
      domOrder.slice(0, 5).join(', ') + ' vs expected ' + expOrder.slice(0, 5).join(', '));
  }

  function sortTests() {
    var g = 'index:sort';
    var sel = document.getElementById('sort-select');
    var opts = Array.prototype.slice.call(sel.options);
    ok(g, 'sort control exposes all strategies', opts.length === 3, opts.map(function (o) { return o.value; }).join(', '));

    var labels = {};
    opts.forEach(function (o) { labels[o.value] = o.textContent.trim(); });
    add(g, 'sort option labels', 'info', JSON.stringify(labels));
    ok(g, 'label for "aa_score" mentions AA', /AA/i.test(labels.aa_score || ''), 'got "' + labels.aa_score + '"');
    ok(g, 'label for "arena_elo" mentions Elo', /[Ee]lo/.test(labels.arena_elo || ''), 'got "' + labels.arena_elo + '"');
    ok(g, 'label for "name" mentions Name', /name/i.test(labels.name || ''), 'got "' + labels.name + '"');

    ['aa_score', 'arena_elo', 'name'].forEach(function (key) {
      var before = renderCalls;
      setSort(key);
      ok(g, 'sorting by ' + key + ' re-renders', renderCalls > before, renderCalls - before + ' render call(s)');
      var exp = expectedOrder(DATA, key);
      var got = names();
      ok(g, 'order correct for ' + key, got.join('|') === exp.join('|'), got.slice(0, 4).join(', ') + ' vs expected ' + exp.slice(0, 4).join(', '));
      ok(g, 'card count stable for ' + key, got.length === DATA.length, got.length + '/' + DATA.length);
    });
    setSort('aa_score');
  }

  function searchTests() {
    var g = 'index:search';
    setSearch('chatgpt');
    ok(g, 'exact name search returns one card', names().join(',') === 'ChatGPT', names().join(', '));

    setSearch('CLAUDE');
    ok(g, 'search is case-insensitive', names().indexOf('Claude') !== -1, names().join(', '));

    setSearch('openai');
    ok(g, 'search matches developer', names().length > 0 && names().indexOf('ChatGPT') !== -1, names().join(', '));

    setSearch('zzqqxx-nothing');
    var empty = document.getElementById('cards-container').textContent;
    ok(g, 'unknown query shows empty state', /No services found/i.test(empty), empty.trim().slice(0, 60));

    setSearch('видео');
    var withVideo = DATA.filter(function (s) { return s.has_video; }).map(function (s) { return s.name; });
    ok(g, 'russian feature keyword "видео"', names().length > 0, names().length + ' cards; services with has_video: ' + withVideo.length + ' [' + withVideo.slice(0, 5).join(', ') + ']');

    setSearch('бесплат');
    var freeNames = DATA.filter(function (s) { return s.free; }).map(function (s) { return s.name; });
    ok(g, 'russian keyword "бесплат" filters free services', names().length > 0 && names().every(function (n) { return freeNames.indexOf(n) !== -1; }), names().length + ' cards vs ' + freeNames.length + ' free services');

    setSearch('vpn');
    var vpnNeeded = DATA.filter(function (s) { return s.vpn; }).map(function (s) { return s.name; });
    ok(g, 'keyword "vpn" returns services that need VPN',
      names().length === vpnNeeded.length && names().every(function (n) { return vpnNeeded.indexOf(n) !== -1; }),
      names().length + ' cards; services with vpn:true = ' + vpnNeeded.length);

    setSearch('');
    ok(g, 'clearing search restores catalog', names().length === DATA.length, names().length + '/' + DATA.length);
  }

  function tabTests() {
    var g = 'index:tabs';
    var TAB_TYPES = ['model', 'tool', 'aggregator', 'all'];
    TAB_TYPES.forEach(function (t) {
      var clicked = clickTab(t);
      if (!clicked) { add(g, 'tab ' + t + ' exists', 'fail', 'no .tab-btn[data-type=' + t + ']'); return; }
      var exp = t === 'all' ? DATA.length : DATA.filter(function (s) { return s.type === t; }).length;
      ok(g, 'tab ' + t + ' filters cards', names().length === exp, names().length + ' cards, expected ' + exp);
      var wrong = cards().filter(function (c) { var s = DATA.filter(function (x) { return x.name === cardName(c); })[0]; return t !== 'all' && s && s.type !== t; }).map(cardName);
      ok(g, 'tab ' + t + ' shows only its type', wrong.length === 0, wrong.slice(0, 4).join(', '));
      var d = document.querySelector('#tab-description .lang-en');
      ok(g, 'tab ' + t + ' updates description', d && d.textContent.length > 10, d ? d.textContent.slice(0, 40) : 'description element missing');
    });
    clickTab('all');
  }

  function langTests() {
    var g = 'index:i18n';
    var ru = document.querySelector('.lang-btn[data-lang="ru"]');
    var en = document.querySelector('.lang-btn[data-lang="en"]');
    if (!ru || !en) { add(g, 'language buttons exist', 'fail', 'missing .lang-btn'); return; }

    var before = renderCalls;
    ru.click();
    var callsPerClick = renderCalls - before;
    warn(g, 'one render per language click', callsPerClick === 1, callsPerClick + ' renderCards() calls - the lang handler is bound twice (script top level + DOMContentLoaded)');

    var descCyr = cards().filter(function (c) { return CYR.test(cardDesc(c)); });
    ok(g, 'RU switch translates card descriptions', cards().length > 0 && descCyr.length === cards().length, descCyr.length + '/' + cards().length + ' cards in Russian');
    var hdr = document.querySelector('header h2.lang-ru');
    warn(g, 'static RU blocks become visible', hdr && hdr.style.display !== 'none', hdr ? 'header RU subtitle shown' : 'no RU header element');
    var sel = document.getElementById('sort-select');
    var ruLabels = Array.prototype.slice.call(sel.options).map(function (o) { return o.textContent.trim(); });
    ok(g, 'sort labels translated to RU', ruLabels.some(function (t) { return CYR.test(t); }), ruLabels.join(' / '));
    var d = document.querySelector('#tab-description .lang-ru');
    ok(g, 'tab description translated to RU', d && CYR.test(d.textContent) && d.style.display !== 'none', d ? d.textContent.slice(0, 50) : 'element missing');

    var before2 = renderCalls;
    en.click();
    ok(g, 'back to EN re-renders', renderCalls > before2, cards().filter(function (c) { return !CYR.test(cardDesc(c)); }).length + '/' + cards().length + ' cards in English');
  }

  function uiTests() {
    var g = 'index:ui';
    var inline = Array.prototype.slice.call(document.querySelectorAll('script:not([src])')).map(function (s) { return s.textContent; }).join('\n');

    // The quick-filter buttons and the country selector were removed from the UI on purpose
    // (single-country catalog, tabs + search are the only filters). Guard against their
    // JS half coming back as dead code.
    ok(g, 'no dead country-filter lookup', !/getElementById\(\s*['"]country-filter['"]/.test(inline),
      'renderCards() must not read a #country-filter control that is not in the markup');

    ok(g, 'no dead .filter-btn handlers', !/querySelector(All)?\(\s*['"]\.filter-btn/.test(inline),
      'quick-filter handlers should be gone together with the buttons');

    ok(g, 'no dead .footer-text hook', !/querySelector\(\s*['"]\.footer-text['"]/.test(inline),
      'the footer is translated through .lang-en / .lang-ru markup, not .footer-text');

    var search = document.getElementById('search-input');
    ok(g, 'search placeholder initialized', !!search && search.placeholder.length > 0, '"' + (search ? search.placeholder : '') + '"');

    var cbtn = document.querySelector('.country-btn');
    if (cbtn) {
      var n1 = cards().length;
      cbtn.click();
      ok(g, 'country button click has no side effects', cards().length === n1, n1 + ' -> ' + cards().length + ' cards (button has no handler; it is a static label)');
    }

    var warnBtn = document.querySelector('#security-warning button');
    if (warnBtn) {
      warnBtn.click();
      var w = document.getElementById('security-warning');
      ok(g, 'security warning can be dismissed', w.style.display === 'none', 'display=' + w.style.display);
    }
    add(g, 'language persistence', 'info', 'index.html keeps language in memory only; sub-pages read localStorage("lang") - switching pages can reset/override the choice');
  }

  function emit() {
    var errs = window.__errs || [];
    ok('index:runtime', 'no uncaught JS errors', errs.length === 0, errs.slice(0, 4).join(' | '));
    add('index:runtime', 'render calls total', 'info', renderCalls + ' renderCards() invocations during the suite');
    var json = JSON.stringify(R);
    var d = document.createElement('div');
    d.id = '__TEST_RESULTS__';
    d.style.display = 'none';
    d.textContent = btoa(unescape(encodeURIComponent(json)));
    document.body.appendChild(d);
  }

  document.addEventListener('DOMContentLoaded', function () {
    try {
      if (dataTests()) { renderTests(); sortTests(); searchTests(); tabTests(); langTests(); uiTests(); }
    } catch (e) {
      add('index:runtime', 'harness completed', 'fail', (e && e.message) + ' @ ' + (e && e.stack ? String(e.stack).split('\n')[1] : ''));
    }
    emit();
  });



})();
