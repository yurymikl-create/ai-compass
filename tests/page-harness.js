/*
 * Injected assertion harness for the AI Compass sub-pages
 * (news.html, data-tools.html, recommendations.html, requirements.html).
 * Also covers the news.json loading path, including its failure branch.
 */
(function () {
  var R = [];
  function add(group, name, status, detail) {
    R.push({ group: group, name: name, status: status, detail: detail == null ? '' : String(detail) });
  }
  function ok(g, n, c, d) { add(g, n, c ? 'pass' : 'fail', d); }
  function warn(g, n, c, d) { add(g, n, c ? 'pass' : 'warn', d); }
  var CYR = /[\u0400-\u04FF]/;
  var PAGE = location.pathname.split('/').pop();
  var G = 'page:' + PAGE;
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function basicChecks() {
    ok(G, 'page has a title', document.title.length > 0, document.title);
    var heads = document.querySelectorAll('h1');
    ok(G, 'page has an <h1>', heads.length >= 1, heads.length ? heads[0].textContent.trim().slice(0, 60) : 'none');

    var anchors = Array.prototype.slice.call(document.querySelectorAll('a'));
    var empty = anchors.filter(function (a) { var h = a.getAttribute('href'); return !h || h === '#' || h.trim() === ''; });
    ok(G, 'no dead/empty links', empty.length === 0, empty.length + ' anchors without href: ' + empty.slice(0, 3).map(function (a) { return a.textContent.trim().slice(0, 20); }).join(', '));

    var internal = anchors.map(function (a) { return a.getAttribute('href'); })
      .filter(function (h) { return h && !/^(https?:|mailto:|#)/.test(h); });
    add(G, 'links', 'info', internal.length + ' internal / ' + (anchors.length - internal.length) + ' external');
    return internal;
  }

  async function linkChecks(internal) {
    var csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    if (csp && /connect-src\s+'none'/.test(csp.getAttribute('content') || '')) {
      add(G, 'all internal links resolve', 'info', 'skipped: this page forbids every network request (connect-src \'none\'), so links cannot be probed with fetch');
      return;
    }
    var broken = [];
    for (var i = 0; i < internal.length; i++) {
      var href = internal[i].split('#')[0];
      if (!href) continue;
      try {
        var res = await fetch(href, { method: 'HEAD' });
        if (!res.ok) broken.push(href + ' -> HTTP ' + res.status);
      } catch (e) { broken.push(href + ' -> ' + e.message); }
    }
    ok(G, 'all internal links resolve', broken.length === 0, broken.slice(0, 5).join(', ') || 'checked ' + internal.length);
  }

  function langChecks() {
    if (typeof window.switchLang !== 'function') { add(G, 'language switcher', 'warn', 'no switchLang() on this page - EN/RU text is hardcoded'); return; }
    var en = document.querySelectorAll('.lang-en');
    var ru = document.querySelectorAll('.lang-ru');
    ok(G, 'bilingual blocks present', en.length > 0 && ru.length > 0, en.length + ' lang-en / ' + ru.length + ' lang-ru elements');

    window.switchLang('ru');
    var ruVisible = Array.prototype.slice.call(ru).filter(function (e) { return e.style.display !== 'none'; });
    var enVisible = Array.prototype.slice.call(en).filter(function (e) { return e.style.display !== 'none'; });
    ok(G, 'switchLang("ru") shows RU only', ruVisible.length === ru.length && enVisible.length === 0, ruVisible.length + '/' + ru.length + ' RU visible, ' + enVisible.length + ' EN still visible');
    ok(G, 'switchLang("ru") updates title', document.title.length > 0, document.title);
    if (document.querySelector('meta[name="ai-compass-storage"][content="none"]')) {
      add(G, 'switchLang("ru") persists choice', 'info', 'skipped: this page stores nothing (privacy by design)');
    } else {
      ok(G, 'switchLang("ru") persists choice', localStorage.getItem('lang') === 'ru', 'localStorage.lang=' + localStorage.getItem('lang'));
    }

    window.switchLang('en');
    var enVisible2 = Array.prototype.slice.call(en).filter(function (e) { return e.style.display !== 'none'; });
    ok(G, 'switchLang("en") restores EN', enVisible2.length === en.length, enVisible2.length + '/' + en.length);
  }

  async function rankingsChecks() {
    var container = document.getElementById('rankings-container');
    if (!container) return;
    var g = 'rankings:' + PAGE;
    var data;
    try { data = await (await fetch('rankings.json')).json(); }
    catch (e) { add(g, 'rankings.json fetchable', 'fail', e.message); return; }

    for (var i = 0; i < 100; i++) {
      if (container.querySelectorAll('.source-card').length > 0) break;
      await sleep(50);
    }
    var cards = Array.prototype.slice.call(container.querySelectorAll('.source-card'));
    ok(g, 'all sources rendered', cards.length === data.sources.length, cards.length + ' cards vs ' + data.sources.length + ' in rankings.json');

    function cardFor(id) { return container.querySelector('.source-card[data-id="' + id + '"]'); }

    var mism = [];
    data.sources.forEach(function (src) {
      var card = cardFor(src.id);
      if (!card) { mism.push(src.name + ': no card'); return; }
      var link = card.querySelector('a.open');
      if (!link || link.getAttribute('href') !== src.url) mism.push(src.name + ': link ' + (link ? link.getAttribute('href') : 'none') + ' != ' + src.url);
      var shownDate = src.checked_at.split('-').reverse().join('.');
      if (card.getAttribute('data-checked') !== src.checked_at) mism.push(src.name + ': data-checked drifted');
      if (card.textContent.indexOf(shownDate) === -1) mism.push(src.name + ': date ' + shownDate + ' not displayed');
      if (src.claims_verified === false && card.getAttribute('data-verified') !== 'no') mism.push(src.name + ': unverified flag missing');
      if (src.claims_verified === false && !/403|not readable|не открылся/.test(card.textContent)) mism.push(src.name + ': blocked status not explained');
    });
    ok(g, 'each card shows its own link, date and honest status', mism.length === 0, mism.slice(0, 4).join('; ') || cards.length + ' cards ok');

    var limitGaps = data.sources.filter(function (s) {
      var card = cardFor(s.id);
      return !card || card.querySelectorAll('.limits li').length !== s.limitations_en.length;
    }).map(function (s) { return s.name; });
    ok(g, 'every limitation is listed on its card', limitGaps.length === 0, limitGaps.join(', ') || 'all limitation lists rendered');

    var toolsBtn = document.querySelector('.section-btn[data-section="tools"]');
    var toolsExpected = data.sources.filter(function (s) { return s.section === 'tools'; }).length;
    if (toolsBtn) {
      toolsBtn.click();
      var toolsShown = container.querySelectorAll('.source-card').length;
      ok(g, 'section filter narrows to tools', toolsShown === toolsExpected, toolsShown + ' shown vs ' + toolsExpected + ' in json');
      document.querySelector('.section-btn[data-section="models"]').click();
      var modelsExpected = data.sources.filter(function (s) { return s.section === 'models'; }).length;
      ok(g, 'section filter narrows to models', container.querySelectorAll('.source-card').length === modelsExpected, modelsExpected + ' expected');
      document.querySelector('.section-btn[data-section="all"]').click();
      ok(g, 'section filter resets', container.querySelectorAll('.source-card').length === data.sources.length, 'restored ' + data.sources.length);
    } else { add(g, 'section filter present', 'fail', 'no .section-btn[data-section="tools"]'); }

    var input = document.getElementById('ranking-search');
    if (input) {
      input.value = 'elo';
      input.dispatchEvent(new Event('input'));
      var hits = container.querySelectorAll('.source-card').length;
      ok(g, 'search narrows the list', hits > 0 && hits < data.sources.length, hits + ' cards for query "elo"');
      input.value = 'zzqqxx';
      input.dispatchEvent(new Event('input'));
      ok(g, 'unknown query shows empty state', /No sources match/i.test(container.textContent), container.textContent.trim().slice(0, 48));
      input.value = '';
      input.dispatchEvent(new Event('input'));
      ok(g, 'clearing search restores all', container.querySelectorAll('.source-card').length === data.sources.length, container.querySelectorAll('.source-card').length + '/' + data.sources.length);
    } else { add(g, 'search control present', 'fail', 'no #ranking-search'); }

    var axes = document.querySelectorAll('#axes-container .axis-card');
    ok(g, 'quality, popularity and reviews are explained', axes.length === data.meta.axes.length, axes.length + ' axis cards');
    var count = document.getElementById('rankings-count');
    ok(g, 'result counter updates', count && /\d/.test(count.textContent), count ? count.textContent : 'missing');

    window.switchLang('ru');
    await sleep(50);
    var ruCard = container.querySelector('.source-card');
    ok(g, 'cards localize to RU', ruCard && CYR.test(ruCard.textContent), ruCard ? ruCard.textContent.slice(0, 36) : 'no card');
    ok(g, 'RU headings used', /Проверено/.test(container.textContent) && /Ограничения/.test(container.textContent), 'checked + limits labels');
    ok(g, 'RU title on tab', /Рейтинги/.test(document.title), document.title);
    window.switchLang('en');
    await sleep(50);
    ok(g, 'EN restored after RU', !CYR.test(container.textContent), container.textContent.slice(0, 36));
  }

  async function newsChecks() {
    var container = document.getElementById('auto-news-container');
    if (!container) return;
    var g = 'news:' + PAGE;
    var expectData = !/broken/i.test(PAGE);

    for (var i = 0; i < 200; i++) {
      // the container ships with a "Loading news..." placeholder, so "has children"
      // is not enough - wait until the feed was rendered or the error state appeared
      var settled = /Failed to load news/i.test(container.innerHTML) ||
        (!/Loading news/i.test(container.textContent) && container.children.length > 0);
      if (settled) break;
      await sleep(50);
    }

    if (!expectData) {
      ok(g, 'missing news.json degrades gracefully', /Failed to load news/i.test(container.innerHTML), container.textContent.trim().slice(0, 60));
      var dateEl0 = document.getElementById('last-updated-date');
      ok(g, 'date placeholder on failure', dateEl0 && dateEl0.textContent.trim() === '—', dateEl0 ? dateEl0.textContent.trim() : 'no date element');
      return;
    }

    var data;
    try { data = await (await fetch('news.json')).json(); }
    catch (e) { add(g, 'news.json fetchable', 'fail', e.message); return; }

    var items = container.querySelectorAll('.news-item');
    ok(g, 'news items rendered', items.length === data.news.length, items.length + ' rendered vs ' + data.news.length + ' in news.json');

    var mism = [];
    Array.prototype.slice.call(items).forEach(function (el, idx) {
      var src = data.news[idx];
      var a = el.querySelector('a');
      if (!a || a.getAttribute('href') !== src.url) mism.push('item ' + idx + ' href ' + (a ? a.getAttribute('href') : 'none') + ' != ' + src.url);
      if (a && a.textContent.trim() !== src.title) mism.push('item ' + idx + ' title mismatch');
      if (el.textContent.indexOf(src.date) === -1) mism.push('item ' + idx + ' date ' + src.date + ' not shown');
    });
    ok(g, 'each item shows correct title/link/date', mism.length === 0, mism.slice(0, 3).join('; ') || items.length + ' items ok');

    var dateEl = document.getElementById('last-updated-date');
    ok(g, 'last_updated date displayed', dateEl && dateEl.textContent.trim() === data.last_updated, dateEl ? dateEl.textContent.trim() + ' vs json ' + data.last_updated : 'element missing');

    var stale = data.news.filter(function (n) { return /example\.com|localhost|placeholder/i.test(n.url); });
    ok(g, 'no placeholder/sample links shipped', stale.length === 0, stale.map(function (n) { return n.url; }).join(', ') || 'all ' + data.news.length + ' urls look real');

    var badSchema = data.news.filter(function (n) { return !n.title || !n.url || !n.date || !n.source; });
    ok(g, 'news.json schema valid', badSchema.length === 0, badSchema.length + ' incomplete items');
    add(g, 'news feed', 'info', data.news.length + ' items, last_updated=' + data.last_updated);
  }

  async function maskerChecks() {
    var input = document.getElementById('mask-input');
    if (!input) return;
    var g = 'masker:' + PAGE;

    input.value = 'Иван Петров, тел +375 29 123-45-67, ivan.petrov@example.by, карта 4111 1111 1111 1111, сумма 125 000 BYN.';
    window.runMask();
    var out = document.getElementById('mask-output').textContent;
    ok(g, 'e-mail is masked', out.indexOf('[EMAIL_1]') !== -1 && out.indexOf('ivan.petrov@example.by') === -1, out.slice(0, 80));
    ok(g, 'card number is masked', out.indexOf('[CARD_1]') !== -1 && out.indexOf('4111 1111 1111 1111') === -1, 'card token present');
    ok(g, 'phone is masked', out.indexOf('[PHONE_1]') !== -1 && out.indexOf('123-45-67') === -1, 'phone token present');
    ok(g, 'amount is masked', out.indexOf('[AMOUNT_1]') !== -1, 'amount token present');

    document.getElementById('unmask-input').value = 'Здравствуйте, [EMAIL_1] и [CARD_1].';
    window.runUnmask();
    var back = document.getElementById('unmask-output').textContent;
    ok(g, 'de-masking restores the original values',
      back.indexOf('ivan.petrov@example.by') !== -1 && back.indexOf('4111 1111 1111 1111') !== -1, back.slice(0, 80));

    document.getElementById('term-input').value = 'Иван Петров';
    window.addTerm();
    out = document.getElementById('mask-output').textContent;
    ok(g, 'a manual term is masked too', out.indexOf('[TERM_1]') !== -1 && out.indexOf('Иван Петров') === -1, out.slice(0, 60));

    document.getElementById('check-input').value = 'Секретно. Карта 4111 1111 1111 1111, ivan@example.by.';
    window.runCheck();
    var rep = document.getElementById('check-report').textContent;
    ok(g, 'the check flags a high risk', /🔴/.test(rep) && /Карта|Card|E-mail/.test(rep), rep.slice(0, 70));

    window.clearAll();
    ok(g, 'clear all wipes the fields',
      document.getElementById('mask-input').value === '' && document.getElementById('mask-output').textContent === '', 'cleared');

    function u16le(v) { return [v & 255, (v >> 8) & 255]; }
    function u32le(v) { return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255]; }
    async function buildDocx(txt) {
      var enc = new TextEncoder();
      var xml = enc.encode('<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>' + txt + '</w:t></w:r></w:p></w:body></w:document>');
      var comp = new Uint8Array(await new Response(new Blob([xml]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
      var nm = enc.encode('word/document.xml');
      var lh = [].concat([80, 75, 3, 4], u16le(20), u16le(0), u16le(8), u16le(0), u16le(0), u32le(0), u32le(comp.length), u32le(xml.length), u16le(nm.length), u16le(0));
      var local = new Uint8Array(lh.length + nm.length + comp.length);
      local.set(lh, 0); local.set(nm, lh.length); local.set(comp, lh.length + nm.length);
      var cdOff = local.length;
      var cd = [].concat([80, 75, 1, 2], u16le(20), u16le(20), u16le(0), u16le(8), u16le(0), u16le(0), u32le(0), u32le(comp.length), u32le(xml.length), u16le(nm.length), u16le(0), u16le(0), u16le(0), u16le(0), u32le(0), u32le(0));
      var central = new Uint8Array(cd.length + nm.length);
      central.set(cd, 0); central.set(nm, cd.length);
      var eocd = [].concat([80, 75, 5, 6], u16le(0), u16le(0), u16le(1), u16le(1), u32le(central.length), u32le(cdOff), u16le(0));
      var out = new Uint8Array(local.length + central.length + eocd.length);
      out.set(local, 0); out.set(central, local.length); out.set(eocd, local.length + central.length);
      return out;
    }

    var docxText = null;
    try {
      var docxFile = new File([await buildDocx('Иван Петров ivan@example.by')], 'sample.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      docxText = await window.readDocx(docxFile);
    } catch (e) { docxText = null; }
    ok(g, '.docx text is extracted in the browser', !!docxText && docxText.indexOf('ivan@example.by') !== -1, docxText ? docxText.slice(0, 50) : 'null');

    var maskTa = document.getElementById('mask-input');
    maskTa.value = '';
    await window.loadFile(new File([await buildDocx('Acme Corp ivan@example.by')], 'm.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), maskTa);
    ok(g, 'a .docx can be loaded into the mask mode', maskTa.value.indexOf('ivan@example.by') !== -1, maskTa.value.slice(0, 40));
    window.runMask();
    ok(g, 'the loaded document is masked', document.getElementById('mask-output').textContent.indexOf('[EMAIL_1]') !== -1, document.getElementById('mask-output').textContent.slice(0, 40));

    var genBytes = window.buildDocxBytes('Итог: [EMAIL_1] и [AMOUNT_1]');
    ok(g, 'a masked .docx can be generated', !!genBytes && genBytes.length > 100, (genBytes ? genBytes.length : 0) + ' bytes');
    var genText = null;
    try { genText = await window.readDocx(new File([genBytes], 'g.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })); } catch (e) { genText = null; }
    ok(g, 'the generated .docx reads back with the tokens', !!genText && genText.indexOf('[EMAIL_1]') !== -1 && genText.indexOf('[AMOUNT_1]') !== -1, genText ? genText.slice(0, 50) : 'null');

    document.getElementById('mask-input').value = 'mail ivan@example.by';
    window.runMask();
    document.getElementById('key-box').value = '';
    document.getElementById('key-pass').value = '';
    await window.exportKey();
    var key = document.getElementById('key-box').value;
    ok(g, 'the mapping key can be exported', key.indexOf('EMAIL_1') !== -1, key.slice(0, 40));

    window.clearAll();
    document.getElementById('key-box').value = key;
    await window.importKey();
    document.getElementById('unmask-input').value = 'Reply for [EMAIL_1]';
    window.runUnmask();
    ok(g, 'a loaded key de-masks an AI reply', document.getElementById('unmask-output').textContent.indexOf('ivan@example.by') !== -1, 'restored');

    add(g, 'password-protected key', 'info', 'not exercised here: PBKDF2 (WebCrypto) does not settle under Chrome --virtual-time-budget; verified separately with node:crypto (PBKDF2 100k + AES-GCM roundtrip, wrong password rejected)');
    document.getElementById('key-pass').value = '';

    var csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    ok(g, 'the page forbids every network request (CSP)', !!csp && /connect-src\s+'none'/.test(csp.getAttribute('content') || ''), 'connect-src none');

    document.getElementById('mask-output').textContent = '';
    window.copyText('mask-output', 'copy-msg1');
    ok(g, 'copying an empty output says so instead of pretending success',
      /Нечего копировать|Nothing to copy/.test(document.getElementById('copy-msg1').textContent),
      document.getElementById('copy-msg1').textContent.slice(0, 50));
    add(g, 'clipboard fallback', 'info', 'copyText() falls back to execCommand and then selects the text; the outcome is reported to the user instead of a fake "copied"');
    ok(g, 'the page declares that it stores nothing', !!document.querySelector('meta[name="ai-compass-storage"][content="none"]'), 'meta present');
  }

  document.addEventListener('DOMContentLoaded', async function () {
    try {
      var internal = basicChecks();
      langChecks();
      await newsChecks();
      await rankingsChecks();
      await maskerChecks();
      await linkChecks(internal);
    } catch (e) {
      add(G, 'harness completed', 'fail', (e && e.message) + ' @ ' + (e && e.stack ? String(e.stack).split('\n')[1] : ''));
    }
    var errs = window.__errs || [];
    ok(G, 'no uncaught JS errors', errs.length === 0, errs.slice(0, 3).join(' | '));
    var d = document.createElement('div');
    d.id = '__TEST_RESULTS__';
    d.style.display = 'none';
    d.textContent = btoa(unescape(encodeURIComponent(JSON.stringify(R))));
    document.body.appendChild(d);
  });

})();
