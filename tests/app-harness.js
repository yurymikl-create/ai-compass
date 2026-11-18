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
    var ACCESS_RANK = { available: 0, via_aggregator: 1, limited: 2, blocked: 3 };
    function rank(s) { var r = ACCESS_RANK[s.access_level]; return r === undefined ? 4 : r; }
    return list.slice().sort(function (a, b) {
      if (key === 'name') return a.name.localeCompare(b.name);
      if (key === 'access') {
        var delta = rank(a) - rank(b);
        return delta !== 0 ? delta : a.name.localeCompare(b.name);
      }
      return ((b[key] || 0) - (a[key] || 0));
    }).map(function (s) { return s.name; });
  }
  var DATA_ORDER_SNAPSHOT = null; // taken once, to prove rendering never mutates `services`
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
    DATA_ORDER_SNAPSHOT = DATA.map(function (s) { return s.name; }).join('|');

    var TAB_TYPES = ['model', 'tool', 'aggregator'];
    var ACCESS = ['available', 'limited', 'blocked', 'via_aggregator'];
    var REQUIRED = ['name', 'type', 'access_level', 'url', 'developer', 'developer_country', 'desc_en', 'desc_ru'];
    var bad = [];
    DATA.forEach(function (s) {
      REQUIRED.forEach(function (k) { if (s[k] === undefined) bad.push(s.name + ': missing ' + k); });
      if (s.type && TAB_TYPES.indexOf(s.type) === -1) bad.push(s.name + ': type "' + s.type + '" has no tab');
      if (s.access_level && ACCESS.indexOf(s.access_level) === -1) bad.push(s.name + ': unknown access_level "' + s.access_level + '"');
      if (s.url && !/^https?:\/\/[^\s]+$/.test(s.url)) bad.push(s.name + ': bad url ' + s.url);
      if (s.aa_score_unverified != null && typeof s.aa_score_unverified !== 'number') bad.push(s.name + ': aa_score_unverified is not a number');
      if (s.arena_elo_unverified != null && typeof s.arena_elo_unverified !== 'number') bad.push(s.name + ': arena_elo_unverified is not a number');
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

    // Third-party numbers in the data are research notes, not published ratings: they must keep
    // the *_unverified names so nothing can render or sort by them by accident.
    var legacyNames = DATA.filter(function (s) {
      return s.aa_score !== undefined || s.arena_elo !== undefined;
    }).map(function (s) { return s.name; });
    ok(g, 'score fields carry the *_unverified names', legacyNames.length === 0,
      legacyNames.length ? 'rename to *_unverified: ' + legacyNames.slice(0, 5).join(', ') : 'no bare aa_score / arena_elo keys in data');
    return true;
  }

  function defaultLangTests() {
    var g = 'index:i18n';
    var ruBtn = document.querySelector('.lang-btn[data-lang="ru"]');
    var enBtn = document.querySelector('.lang-btn[data-lang="en"]');
    ok(g, 'Russian is the default language', !!ruBtn && ruBtn.classList.contains('active'),
      ruBtn ? 'RU active=' + ruBtn.classList.contains('active') : 'no RU button');
    var ruHdr = document.querySelector('header h2.lang-ru');
    var enHdr = document.querySelector('header h2.lang-en');
    ok(g, 'the Russian subtitle is shown on load',
      !!ruHdr && ruHdr.style.display !== 'none' && (!enHdr || enHdr.style.display === 'none'),
      'ru=' + (ruHdr ? JSON.stringify(ruHdr.style.display) : 'n/a') + ' en=' + (enHdr ? JSON.stringify(enHdr.style.display) : 'n/a'));
    if (enBtn) enBtn.click(); // normalise the remaining checks to English
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

    var COUNTRY = { US: 'United States', CN: 'China', RU: 'Russia', BY: 'Belarus', KZ: 'Kazakhstan', FR: 'France' };
    var noCountry = el.filter(function (c) {
      var s = DATA.filter(function (x) { return x.name === cardName(c); })[0];
      if (!s || !s.developer_country) return false;
      var label = COUNTRY[s.developer_country];
      return label && c.textContent.indexOf(label) === -1;
    }).map(cardName);
    ok(g, 'every card names the developer country in full', noCountry.length === 0,
      noCountry.slice(0, 4).join(', ') || el.length + ' cards show the country');

    var domOrder = names();
    var expOrder = expectedOrder(DATA, 'access');
    ok(g, 'default sort shows available services first', domOrder.join('|') === expOrder.join('|'),
      domOrder.slice(0, 5).join(', ') + ' vs expected ' + expOrder.slice(0, 5).join(', '));
    var cardText = document.getElementById('cards-container').textContent;
    ok(g, 'no star glyphs on cards', cardText.indexOf('\u2605') === -1 && cardText.indexOf('\u2606') === -1, 'card text is free of \u2605 / \u2606');
    var scoreChip = cards().filter(function (c) {
      var head = c.querySelector('h3');
      return head && /\d{2,4}\s*★/.test(head.parentElement.textContent);
    }).map(cardName);
    ok(g, 'no numeric rating chip next to the title', scoreChip.length === 0, scoreChip.join(', ') || 'titles carry no third-party score');
  }

  function sortTests() {
    var g = 'index:sort';
    var sel = document.getElementById('sort-select');
    var opts = Array.prototype.slice.call(sel.options);
    var values = opts.map(function (o) { return o.value; });
    ok(g, 'sort control offers availability and name only', values.join('|') === 'access|name', values.join(', '));
    ok(g, 'availability is the selected default', sel.options[sel.selectedIndex].value === 'access', 'selected=' + sel.options[sel.selectedIndex].value);
    ok(g, 'no rating sort options remain', values.indexOf('aa_score') === -1 && values.indexOf('arena_elo') === -1, values.join(', '));

    var labels = {};
    opts.forEach(function (o) { labels[o.value] = o.textContent.trim(); });
    add(g, 'sort option labels', 'info', JSON.stringify(labels));
    ok(g, 'label for "access" mentions availability', /availab|доступн/i.test(labels.access || ''), 'got "' + labels.access + '"');
    ok(g, 'label for "name" mentions Name', /name|назван/i.test(labels.name || ''), 'got "' + labels.name + '"');

    ['access', 'name'].forEach(function (key) {
      var before = renderCalls;
      setSort(key);
      ok(g, 'sorting by ' + key + ' re-renders', renderCalls > before, renderCalls - before + ' render call(s)');
      var exp = expectedOrder(DATA, key);
      var got = names();
      ok(g, 'order correct for ' + key, got.join('|') === exp.join('|'), got.slice(0, 4).join(', ') + ' vs expected ' + exp.slice(0, 4).join(', '));
      ok(g, 'card count stable for ' + key, got.length === DATA.length, got.length + '/' + DATA.length);
    });
    var byAccess = expectedOrder(DATA, 'access');
    var byName = expectedOrder(DATA, 'name');
    ok(g, 'availability order differs from alphabetical', byAccess.join('|') !== byName.join('|'),
      'first divergence at index ' + byAccess.findIndex(function (n, i) { return n !== byName[i]; }));
    setSort('access');

    var RANK = { available: 0, via_aggregator: 1, limited: 2, blocked: 3 };
    var domRanks = names().map(function (n) {
      var s = DATA.filter(function (x) { return x.name === n; })[0];
      return s ? (RANK[s.access_level] === undefined ? 4 : RANK[s.access_level]) : 4;
    });
    var inversions = 0;
    for (var k = 1; k < domRanks.length; k++) { if (domRanks[k] < domRanks[k - 1]) inversions++; }
    ok(g, 'DOM never shows a blocked service above an available one', inversions === 0,
      inversions + ' inversions; ranks ' + domRanks.slice(0, 8).join('') + '...');
    ok(g, 'sorting never mutates the services array',
      DATA.map(function (s) { return s.name; }).join('|') === DATA_ORDER_SNAPSHOT,
      'data drifted, starts with ' + DATA.slice(0, 3).map(function (s) { return s.name; }).join(', '));
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
    ok(g, 'keyword "vpn" includes every service that needs VPN',
      vpnNeeded.every(function (n) { return names().indexOf(n) !== -1; }),
      names().length + ' cards; services with vpn:true = ' + vpnNeeded.length);

    setSearch('флагманск');
    var ruDescHits = DATA.filter(function (s) { return ((s.desc_en || '') + ' ' + (s.desc_ru || '')).toLowerCase().indexOf('флагманск') !== -1; }).map(function (s) { return s.name; });
    ok(g, 'search covers Russian descriptions', ruDescHits.length > 0 && ruDescHits.every(function (n) { return names().indexOf(n) !== -1; }),
      names().length + ' cards for "флагманск"; matching descriptions: ' + ruDescHits.length);

    setSearch('flagship');
    var enDescHits = DATA.filter(function (s) { return ((s.desc_en || '') + ' ' + (s.desc_ru || '')).toLowerCase().indexOf('flagship') !== -1; }).map(function (s) { return s.name; });
    ok(g, 'search covers English descriptions', enDescHits.length > 0 && enDescHits.every(function (n) { return names().indexOf(n) !== -1; }),
      names().length + ' cards for "flagship"; matching descriptions: ' + enDescHits.length);

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

  function categoryTests() {
    var g = 'index:category';
    var CATS = {
      model: ['chat', 'open', 'regional', 'search'],
      tool: ['image', 'video', 'audio', 'code', 'productivity', 'research'],
      aggregator: ['api', 'chat', 'studio', 'hub']
    };
    var bad = DATA.filter(function (s) { return !s.category || (CATS[s.type] || []).indexOf(s.category) === -1; });
    ok(g, 'every service carries a valid category', bad.length === 0,
      bad.map(function (s) { return s.name + '=' + s.category + '/' + s.type; }).slice(0, 5).join(', ') || DATA.length + ' services categorised');

    var chips = document.querySelectorAll('#category-chips .chip');
    ok(g, 'category chip row is rendered', chips.length > 0, chips.length + ' chips');

    clickTab('tool');
    var videoChip = document.querySelector('#category-chips .chip[data-cat="video"]');
    ok(g, 'tool tab offers a video chip', !!videoChip, videoChip ? videoChip.textContent.trim() : 'missing');
    if (videoChip) {
      videoChip.click();
      var videoTools = DATA.filter(function (s) { return s.type === 'tool' && s.category === 'video'; }).map(function (s) { return s.name; });
      ok(g, 'video chip shows only video tools', names().length === videoTools.length && names().every(function (n) { return videoTools.indexOf(n) !== -1; }),
        names().length + ' shown vs ' + videoTools.length);
    }

    clickTab('all');
    var noVpnChip = document.querySelector('#category-chips .chip[data-cat="__no_vpn"]');
    ok(g, 'no-VPN chip is present', !!noVpnChip, noVpnChip ? noVpnChip.textContent.trim() : 'missing');
    if (noVpnChip) {
      noVpnChip.click();
      var usable = DATA.filter(function (s) { return s.vpn === false && s.access_level !== 'blocked'; }).map(function (s) { return s.name; });
      ok(g, 'no-VPN chip hides everything that needs a VPN',
        names().length === usable.length && names().every(function (n) { return usable.indexOf(n) !== -1; }),
        names().length + ' shown vs ' + usable.length);
    }

    var allChip = document.querySelector('#category-chips .chip[data-cat="all"]');
    var newChip = document.querySelector('#category-chips .chip[data-cat="__new"]');
    ok(g, 'new chip is present', !!newChip, newChip ? newChip.textContent.trim() : 'missing');
    var newNames = DATA.filter(function (s) {
      if (!s.added_at) return false;
      var t = new Date(s.added_at).getTime();
      return !isNaN(t) && (Date.now() - t) / 86400000 <= 30;
    }).map(function (s) { return s.name; });
    ok(g, 'the catalog has recently added services to badge', newNames.length > 0, newNames.length + ' services added in the last 30 days');
    if (newChip) {
      newChip.click();
      ok(g, 'new chip shows only recently added services',
        names().length === newNames.length && names().every(function (n) { return newNames.indexOf(n) !== -1; }),
        names().length + ' shown vs ' + newNames.length);
    }

    if (allChip) allChip.click();
    clickTab('all');
    ok(g, 'chip reset restores the full catalog', names().length === DATA.length, names().length + '/' + DATA.length);
    var badges = cards().filter(function (c) { return c.querySelector('.tag-new'); }).length;
    ok(g, 'recently added cards carry a New badge', badges === newNames.length, badges + ' badges vs ' + newNames.length + ' new services');
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
    ok(g, 'RU switch translates the browser tab title', CYR.test(document.title), '"' + document.title + '"');

    var before2 = renderCalls;
    en.click();
    ok(g, 'back to EN re-renders', renderCalls > before2, cards().filter(function (c) { return !CYR.test(cardDesc(c)); }).length + '/' + cards().length + ' cards in English');
    ok(g, 'EN switch restores the EN tab title', /AI Compass/.test(document.title) && !CYR.test(document.title), '"' + document.title + '"');
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

    var header = document.querySelector('header');
    var headerText = header ? header.textContent.replace(/\s+/g, ' ').trim() : '';
    ok(g, 'header states the Belarus focus', /Belarus/i.test(headerText) || /Беларус/.test(headerText), headerText.slice(0, 90));

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
      if (dataTests()) { defaultLangTests(); renderTests(); sortTests(); searchTests(); tabTests(); categoryTests(); langTests(); uiTests(); }
    } catch (e) {
      add('index:runtime', 'harness completed', 'fail', (e && e.message) + ' @ ' + (e && e.stack ? String(e.stack).split('\n')[1] : ''));
    }
    emit();
  });



})();
