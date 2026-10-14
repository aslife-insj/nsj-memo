/* НСЖ 2026 · памятка менеджера.
 * Страница ничего не хранит внутри себя: условия и тексты берёт из content.json,
 * актуальные презентеры (PDF) — из хранилища. См. SETUP.md.
 * Код намеренно простой (без сборки и библиотек), рассчитан на iOS 12+ и Android 7+. */
(function () {
  'use strict';

  var C = null;                         // content.json
  var M = { state: 'idle', map: {} };   // презентеры: state = idle | loading | ok | error | off
  var FILES = {};                       // url -> File | 'loading' | 'failed'  (PDF, подготовленный к отправке)
  var ST = { filter: 'all', a: 0, b: 1, homeScroll: 0 };
  var screenEl = document.getElementById('screen');
  var toastEl = document.getElementById('toast');
  var lastRoute = '';

  /* ---------- утилиты ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function arr(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }
  function norm(t) { return String(t).toLowerCase().replace(/ё/g, 'е').replace(/,/g, '.'); }
  function ul(v) { return '<ul>' + arr(v).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'; }
  function byId(list, id) { for (var i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; } return null; }
  function catOf(p) { return byId(C.categories, p.category) || { short: '', source: '' }; }

  function fmtDate(ms) {
    var d = new Date(ms);
    try { return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Moscow' }); }
    catch (e) { return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear(); }
  }
  function fmtSize(b) {
    if (!b) return '';
    return b >= 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ';
  }
  var toastTimer;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.className = 'toast show';
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.className = 'toast'; }, 3200);
  }

  /* ---------- презентеры: какой файл самый свежий ---------- */
  function encodeKey(key) { return key.split('/').map(encodeURIComponent).join('/'); }

  function listPage(cfg, token, acc, n) {
    var sep = cfg.listing_url.indexOf('?') > -1 ? '&' : '?';
    var u = cfg.listing_url + sep + 'list-type=2&prefix=' + encodeURIComponent(cfg.prefix) +
      (token ? '&continuation-token=' + encodeURIComponent(token) : '');
    return fetch(u, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('list ' + r.status);
      return r.text();
    }).then(function (xml) {
      var doc = new DOMParser().parseFromString(xml, 'application/xml');
      var items = doc.getElementsByTagName('Contents');
      for (var i = 0; i < items.length; i++) {
        var g = function (t) { var e = items[i].getElementsByTagName(t)[0]; return e ? e.textContent : ''; };
        acc.push({ key: g('Key'), lm: Date.parse(g('LastModified')), size: parseInt(g('Size'), 10) || 0 });
      }
      var tr = doc.getElementsByTagName('IsTruncated')[0], nx = doc.getElementsByTagName('NextContinuationToken')[0];
      if (tr && tr.textContent === 'true' && nx && n < 10) return listPage(cfg, nx.textContent, acc, n + 1);
      return acc;
    });
  }
  function fromListing(cfg) {
    return listPage(cfg, '', [], 0).then(function (items) {
      var map = {};
      items.forEach(function (it) {
        if (!/\.pdf$/i.test(it.key) || !it.size) return;
        var rest = it.key.slice(cfg.prefix.length).split('/');
        if (rest.length < 2) return;                       // ждём presenters/<продукт>/<файл>.pdf
        var folder = rest.slice(0, -1).join('/'), cur = map[folder];
        if (!cur || it.lm > cur.lm) {                      // побеждает файл с самой свежей датой
          map[folder] = { url: cfg.base_url + encodeKey(it.key), lm: it.lm, size: it.size, name: rest[rest.length - 1] };
        }
      });
      return map;
    });
  }
  function fromManifest(cfg) {
    return fetch(cfg.manifest_url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('manifest ' + r.status);
      return r.json();
    }).then(function (j) {
      var map = {};
      Object.keys(j).forEach(function (k) {
        var m = j[k];
        map[k] = { url: /^https?:|^\//.test(m.url || '') ? m.url : cfg.base_url + encodeKey(m.url || m.file), lm: Date.parse(m.updated), size: m.size || 0, name: m.file || '' };
      });
      return map;
    });
  }
  function loadMaterials() {
    var cfg = C.materials;
    if (!cfg) { M.state = 'off'; return Promise.resolve(); }
    M.state = 'loading';
    return (cfg.source === 'manifest' ? fromManifest(cfg) : fromListing(cfg)).then(function (map) {
      M.map = map; M.state = 'ok';
    }).catch(function () { M.state = 'error'; });
  }

  /* подготовить PDF заранее: Safari разрешает «Поделиться» только сразу по нажатию,
     поэтому файл должен быть уже скачан к моменту касания */
  function prefetch(url, name) {
    if (FILES[url]) { refreshShareButtons(); return; }
    FILES[url] = 'loading';
    fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); }).then(function (b) {
      try { FILES[url] = new File([b], name, { type: 'application/pdf' }); } catch (e) { FILES[url] = 'failed'; }
    }).catch(function () { FILES[url] = 'failed'; }).then(refreshShareButtons);
  }
  function refreshShareButtons() {
    var bs = document.querySelectorAll('[data-share-file]');
    for (var i = 0; i < bs.length; i++) {
      var f = FILES[bs[i].getAttribute('data-url')];
      if (f === 'loading' || !f) { bs[i].disabled = true; bs[i].textContent = 'Готовлю…'; }
      else if (f === 'failed') { bs[i].disabled = false; bs[i].textContent = 'Скачать'; bs[i].setAttribute('data-mode', 'open'); }
      else { bs[i].disabled = false; bs[i].textContent = 'Поделиться'; bs[i].removeAttribute('data-mode'); }
    }
  }
  function saveBlob(file) {
    var u = URL.createObjectURL(file), a = document.createElement('a');
    a.href = u; a.download = file.name; document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(u); }, 1500);
  }
  function shareFile(btn) {
    var url = btn.getAttribute('data-url'), title = btn.getAttribute('data-title'), f = FILES[url];
    if (btn.getAttribute('data-mode') === 'open' || !f || f === 'loading' || f === 'failed') { window.open(url, '_blank'); return; }
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [f] })) {
      navigator.share({ files: [f], title: title }).catch(function (e) {
        if (e && e.name !== 'AbortError') { saveBlob(f); toast('PDF сохранён на устройство'); }
      });
      return;
    }
    saveBlob(f);
    toast('PDF сохранён. Текст рассылки — кнопка «Скопировать текст».');
  }

  /* ---------- копирование текста рассылки ---------- */
  function flash(b, txt) {
    var old = b.getAttribute('data-l') || b.textContent; b.setAttribute('data-l', old);
    b.textContent = txt; clearTimeout(b._t); b._t = setTimeout(function () { b.textContent = old; }, 2200);
  }
  function copyText(t, b) {
    var ok = false;
    try {
      t.readOnly = true; t.focus(); t.select(); t.setSelectionRange(0, t.value.length);
      ok = document.execCommand('copy'); t.readOnly = false; t.blur();
      var s = window.getSelection && window.getSelection(); if (s && s.removeAllRanges) s.removeAllRanges();
    } catch (e) { ok = false; t.readOnly = false; }
    if (ok) { flash(b, 'Скопировано ✓'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t.value).then(function () { flash(b, 'Скопировано ✓'); },
        function () { flash(b, 'Нажмите на текст и скопируйте'); });
      return;
    }
    flash(b, 'Нажмите на текст и скопируйте');
  }
  function grow(t) { t.rows = 1; t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px'; }

  /* ---------- экраны ---------- */
  function card(p, forSearch) {
    var c = catOf(p);
    var s = forSearch ? ' data-s="' + esc(norm([p.name, c.short, p.term, p.key, p.payment, p.keydesc, p.term_full, p.contribution,
      p.age, arr(p.income).join(' '), arr(p.medical).join(' '), arr(p.features).join(' '), arr(p.audience).join(' '),
      p.commission, p.limit || ''].join(' '))) + '"' : '';
    return '<a class="product-card" data-cat="' + esc(p.category) + '" href="#p-' + esc(p.id) + '"' + s + '>' +
      '<span class="card-top"><span class="category">' + esc(c.short) + '</span><span class="arrow">↗</span></span>' +
      '<strong>' + esc(p.name) + '</strong>' +
      '<span class="mini"><b>' + esc(p.term) + '</b><i>·</i><b>' + esc(p.key) + '</b><i>·</i><span>' + esc(p.payment) + '</span></span>' +
      '<span class="desc">' + esc(p.keydesc) + '</span></a>';
  }
  function backBar() { return '<div class="backbar"><a class="back" href="#products"><span>←</span> Все продукты</a></div>'; }

  function viewHome() {
    var chips = [{ id: 'all', t: 'Все' }].concat(C.categories.map(function (c) { return { id: c.id, t: c.short }; }));
    return '<section class="screen"><h1>Памятка по продуктам</h1>' +
      '<p class="lead">Все ключевые условия в одном месте. Открой продукт или используй поиск.</p>' +
      '<div class="chips" id="chips">' + chips.map(function (c) {
        return '<button type="button" class="chip' + (ST.filter === c.id ? ' on' : '') + '" data-filter="' + esc(c.id) + '">' + esc(c.t) + '</button>';
      }).join('') + '</div><div class="product-list" id="list">' + listHtml() + '</div></section>';
  }
  function listHtml() {
    return C.products.filter(function (p) { return ST.filter === 'all' || p.category === ST.filter; })
      .map(function (p) { return card(p); }).join('');
  }

  function pres(p) { return p.presenters || (p.presenter ? [p.presenter] : []); }
  function prefetchAll(p) {
    if (M.state !== 'ok') return;
    pres(p).forEach(function (x) { var m = M.map[x.folder]; if (m) prefetch(m.url, x.share_name); });
  }
  function matRow(x) {
    var m = M.map[x.folder];
    if (!m) return '<div class="mat-row"><div class="mat-info"><b>' + esc(x.title) + '</b><span>пока не загружен</span></div></div>';
    var meta = ['PDF', 'актуально ' + fmtDate(m.lm)];
    if (m.size) meta.push(fmtSize(m.size));
    return '<div class="mat-row"><div class="mat-info"><b>' + esc(x.title) + '</b><span>' + esc(meta.join(' · ')) + '</span></div>' +
      '<div class="mat-btns"><a class="btn btn-ghost" href="' + esc(m.url) + '" target="_blank" rel="noopener">Открыть</a>' +
      '<button type="button" class="btn btn-solid" data-share-file data-url="' + esc(m.url) + '" data-title="' + esc(x.share_name.replace(/\.pdf$/i, '')) + '" disabled>Готовлю…</button></div></div>';
  }
  function materialsBlock(p) {
    if (!C.materials || !pres(p).length) return '';
    var head = '<div class="materials"><h3>Материалы для клиента</h3>', end = '</div>';
    if (M.state === 'idle' || M.state === 'loading') {
      return head + '<span class="sk" style="width:60%"></span><span class="sk" style="width:35%"></span>' + end;
    }
    if (M.state === 'error') {
      return head + '<div class="mat-note">Не удалось получить список презентеров. Проверьте интернет и попробуйте ещё раз.</div>' +
        '<button type="button" class="btn btn-ghost mat-retry" data-retry>Повторить</button>' + end;
    }
    return head + pres(p).map(matRow).join('') + end;
  }

  function viewDetail(p) {
    var c = catOf(p), vid = '';
    if (p.video) vid = '<a class="btn btn-video" href="#video-' + esc(p.video) + '"><span class="ico">▶</span>Смотреть видео о программе</a>';
    else if (p.video_link) vid = '<a class="btn btn-video" href="' + esc(p.video_link) + '" target="_blank" rel="noopener"><span class="ico">▶</span>Смотреть видео о программе</a>';
    var mail = '<details class="mailing"><summary><span class="ico">✉</span>Рассылка для клиента</summary><div class="mail-body">' +
      '<p class="mail-hint">Скопируйте текст и вставьте в мессенджер — в начале замените [Имя клиента] на имя клиента.</p>' +
      '<textarea class="mail-text" rows="14" spellcheck="false" aria-label="Текст рассылки">' + esc(p.mailing) + '</textarea>' +
      '<div class="mail-actions"><button type="button" class="btn btn-copy" data-copy>Скопировать текст</button></div></div></details>';
    var lim = p.limit ? '<div class="fact"><span class="lbl">Лимит лечения</span><div>' + esc(p.limit) + '</div></div>' : '';
    return '<section class="screen screen--detail">' + backBar() +
      '<div class="detail-head"><div class="eyebrow">' + esc(c.short) + '</div><h2>' + esc(p.name) + '</h2></div>' +
      '<div class="commission"><span>Комиссия</span><b>' + esc(p.commission) + '</b></div>' +
      '<div class="quickgrid"><div class="metric"><b>' + esc(p.term) + '</b><span>срок</span></div>' +
      '<div class="metric"><b class="accent">' + esc(p.key) + '</b><span>' + esc(p.keydesc) + '</span></div>' +
      '<div class="metric"><b>' + esc(p.payment) + '</b><span>' + esc(p.paydesc) + '</span></div></div>' +
      '<div class="actions">' + vid + mail + '<div id="materials">' + materialsBlock(p) + '</div></div>' +
      '<div class="summary-card"><h3>Основные условия</h3>' +
      '<div class="fact"><span class="lbl">Срок</span><div>' + esc(p.term_full) + '</div></div>' +
      '<div class="fact"><span class="lbl">Взнос</span><div>' + esc(p.contribution) + '</div></div>' +
      '<div class="fact"><span class="lbl">Возраст</span><div>' + esc(p.age) + '</div></div>' + lim +
      '<div class="fact"><span class="lbl">Страховщик</span><div>' + esc(p.factory) + '</div></div></div>' +
      '<details open><summary>Доход / ключевая выгода</summary><div class="detail-body">' + ul(p.income) + '</div></details>' +
      '<details><summary>' + esc(p.medical_title) + '</summary><div class="detail-body">' + ul(p.medical) + '</div></details>' +
      '<details><summary>Фишка продукта</summary><div class="detail-body">' + ul(p.features) + '</div></details>' +
      '<details><summary>Кому подойдет</summary><div class="detail-body">' + ul(p.audience) + '</div></details>' +
      (p.footnote ? '<div class="source">' + esc(p.footnote) + '</div>' : '') +
      '<div class="source">Источник: ' + esc(c.source) + '</div>' +
      '<a class="back back--bottom" href="#products"><span>←</span> Все продукты</a></section>';
  }

  function viewVideo(v) {
    var links = v.products.map(function (id) {
      var p = byId(C.products, id);
      return p ? '<a class="btn btn-ghost" href="#p-' + esc(p.id) + '">К программе «' + esc(p.name) + '»</a>' : '';
    }).join('');
    return '<section class="screen">' + backBar() +
      '<div class="detail-head"><div class="eyebrow">Видео</div><h2>' + esc(v.title) + '</h2></div>' +
      '<div class="videowrap"><video controls playsinline preload="metadata" poster="' + esc(v.poster) + '" src="' + esc(v.url) + '">' +
      'Видео не поддерживается этим браузером.</video></div>' +
      '<div class="twobtn">' + links + '<a class="btn btn-ghost" href="' + esc(v.url) + '" target="_blank" rel="noopener">Открыть видео отдельно</a></div></section>';
  }

  var CMP = [
    ['Комиссия', function (p) { return p.commission; }],
    ['Направление', function (p) { return catOf(p).short; }],
    ['Срок', function (p) { return p.term_full; }],
    ['Взнос', function (p) { return p.contribution; }],
    ['Возраст', function (p) { return p.age; }],
    ['Доход / кешбэк', function (p) { return arr(p.income).join(' · '); }],
    ['Медсервис / лечение', function (p) { return arr(p.medical).join(' · '); }]
  ];
  function cmpRows() {
    var A = C.products[ST.a], B = C.products[ST.b];
    return CMP.map(function (r) {
      return '<div class="compare-row"><div class="row-title">' + esc(r[0]) + '</div><div class="compare-values">' +
        '<div class="col"><div class="a" style="display:block"><b>' + esc(A.name) + '</b>' + esc(r[1](A)) + '</div></div>' +
        '<div class="col"><div class="b" style="display:block"><b>' + esc(B.name) + '</b>' + esc(r[1](B)) + '</div></div></div></div>';
    }).join('');
  }
  function cmpChips(side) {
    return C.products.map(function (p, i) {
      return '<button type="button" class="chip' + (ST[side] === i ? ' on' : '') + '" data-cmp="' + side + '" data-i="' + i + '">' + esc(p.name) + '</button>';
    }).join('');
  }
  function viewCompare() {
    return '<section class="screen"><h1>Сравнить продукты</h1><p class="lead">Выбери два продукта — сравнение без горизонтального скролла.</p>' +
      '<div class="pick-label">Продукт A</div><div class="chips" id="cmpA">' + cmpChips('a') + '</div>' +
      '<div class="pick-label">Продукт B</div><div class="chips" id="cmpB">' + cmpChips('b') + '</div>' +
      '<div class="compare-content" id="cmpRows">' + cmpRows() + '</div></section>';
  }

  function viewSearch() {
    return '<section class="screen"><h1>Поиск</h1><p class="lead">Ищи по названию, сроку, проценту, взносу или формулировке.</p>' +
      '<div class="searchbox"><input id="q" type="search" placeholder="Например: 33%, 5 лет, лечение" autocomplete="off" autocorrect="off" enterkeyhint="search"><span>⌕</span></div>' +
      '<div id="searchResults" class="product-list">' + C.products.map(function (p) { return card(p, true); }).join('') +
      '</div><div id="empty" class="empty">Ничего не найдено</div></section>';
  }

  function viewError() {
    return '<div class="center"><p>Не удалось загрузить памятку. Проверьте интернет.</p>' +
      '<button type="button" class="btn btn-solid" data-reload style="max-width:220px;margin:0 auto">Повторить</button></div>';
  }

  /* ---------- маршрутизация ---------- */
  function currentRoute() { return decodeURIComponent((location.hash || '#products').slice(1)) || 'products'; }

  function render() {
    var r = currentRoute(), html, nav = 'products', p, v, isHome = false;
    if (lastRoute === 'products') ST.homeScroll = window.pageYOffset || 0;
    if (!C) { screenEl.innerHTML = '<div class="center">Загружаю памятку…</div>'; return; }
    if (r.indexOf('p-') === 0 && (p = byId(C.products, r.slice(2)))) {
      html = viewDetail(p);
    } else if (r.indexOf('video-') === 0 && (v = byId(C.videos || [], r.slice(6)))) {
      html = viewVideo(v);
    } else if (r === 'compare') { html = viewCompare(); nav = 'compare'; }
    else if (r === 'search') { html = viewSearch(); nav = 'search'; }
    else { html = viewHome(); isHome = true; r = 'products'; }
    screenEl.innerHTML = html;
    var navs = document.querySelectorAll('[data-nav]');
    for (var i = 0; i < navs.length; i++) navs[i].className = 'navbtn' + (navs[i].getAttribute('data-nav') === nav ? ' on' : '');
    window.scrollTo(0, isHome && lastRoute !== 'products' ? ST.homeScroll : 0);
    lastRoute = r;
    var ta = screenEl.querySelector('.mail-text');
    if (ta) { var d = ta.parentNode.parentNode; if (d.open) grow(ta); }
    if (p) prefetchAll(p);
    refreshShareButtons();
  }

  /* обновить только блок «Материалы» — не трогая остальную страницу (прокрутка, раскрытый текст) */
  function updateMaterialsUI() {
    var r = currentRoute(), p = r.indexOf('p-') === 0 ? byId(C.products, r.slice(2)) : null, box = document.getElementById('materials');
    if (!p || !box) return;
    box.innerHTML = materialsBlock(p);
    prefetchAll(p);
    refreshShareButtons();
  }

  /* ---------- события ---------- */
  document.addEventListener('click', function (ev) {
    var el = ev.target, attrs = ['data-filter', 'data-cmp', 'data-copy', 'data-share-file', 'data-retry', 'data-reload'], k;
    while (el && el !== document) {
      for (k = 0; k < attrs.length; k++) { if (el.hasAttribute && el.hasAttribute(attrs[k])) { handle(el, attrs[k]); return; } }
      el = el.parentNode;
    }
  }, false);

  function handle(el, what) {
    if (what === 'data-filter') {
      ST.filter = el.getAttribute('data-filter');
      var cs = document.querySelectorAll('#chips .chip');
      for (var i = 0; i < cs.length; i++) cs[i].className = 'chip' + (cs[i] === el ? ' on' : '');
      document.getElementById('list').innerHTML = listHtml();
    } else if (what === 'data-cmp') {
      ST[el.getAttribute('data-cmp')] = parseInt(el.getAttribute('data-i'), 10);
      document.getElementById('cmpA').innerHTML = cmpChips('a');
      document.getElementById('cmpB').innerHTML = cmpChips('b');
      document.getElementById('cmpRows').innerHTML = cmpRows();
    } else if (what === 'data-copy') {
      var body = el.parentNode.parentNode, t = body.getElementsByTagName('textarea')[0];
      if (t) copyText(t, el);
    } else if (what === 'data-share-file') {
      shareFile(el);
    } else if (what === 'data-retry') {
      M.state = 'loading'; updateMaterialsUI(); loadMaterials().then(updateMaterialsUI);
    } else if (what === 'data-reload') {
      location.reload();
    }
  }

  document.addEventListener('input', function (ev) {
    var t = ev.target;
    if (t && t.id === 'q') {
      var q = norm(t.value).replace(/^\s+|\s+$/g, ''), cs = document.querySelectorAll('#searchResults .product-card'), n = 0;
      for (var i = 0; i < cs.length; i++) {
        var ok = !q || cs[i].getAttribute('data-s').indexOf(q) > -1;
        cs[i].style.display = ok ? '' : 'none'; if (ok) n++;
      }
      document.getElementById('empty').style.display = n ? 'none' : 'block';
    } else if (t && t.className === 'mail-text') { grow(t); }
  }, false);
  document.addEventListener('keydown', function (ev) {
    if (ev.keyCode === 13 && ev.target && ev.target.id === 'q') ev.target.blur();
  }, false);
  document.addEventListener('toggle', function (ev) {      // «Рассылка» раскрылась — подогнать высоту текста
    var d = ev.target;
    if (d && d.open && d.getElementsByTagName) { var a = d.getElementsByTagName('textarea')[0]; if (a) grow(a); }
  }, true);
  window.addEventListener('hashchange', render, false);
  if (navigator.share) document.documentElement.className += ' can-share';

  /* ---------- старт ---------- */
  function start() {
    fetch('content.json', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('content ' + r.status);
      return r.json();
    }).then(function (j) {
      C = j; render();
      return loadMaterials();
    }).then(function () { if (C) updateMaterialsUI(); })
      .catch(function () { if (!C) screenEl.innerHTML = viewError(); });
  }
  start();
})();
