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
    ok(G, 'switchLang("ru") persists choice', localStorage.getItem('lang') === 'ru', 'localStorage.lang=' + localStorage.getItem('lang'));

    window.switchLang('en');
    var enVisible2 = Array.prototype.slice.call(en).filter(function (e) { return e.style.display !== 'none'; });
    ok(G, 'switchLang("en") restores EN', enVisible2.length === en.length, enVisible2.length + '/' + en.length);
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

  document.addEventListener('DOMContentLoaded', async function () {
    try {
      var internal = basicChecks();
      langChecks();
      await newsChecks();
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
