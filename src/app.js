import { parseSubscription, parseLink, parseUserinfo, parseTitle, hash } from './lib/parser.js';
import { buildConfig, defaultSettings, API_PORT } from './lib/singbox.js';

// ---------- Мост к Rust (или заглушка для предпросмотра в браузере) ----------
const T = window.__TAURI__;
const bridge = T
  ? { invoke: T.core.invoke, listen: T.event.listen, win: T.window.getCurrentWindow() }
  : await import('./mock.js').then((m) => m.bridge);
const { invoke, listen, win } = bridge;

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- Состояние ----------
const state = {
  subs: [], // { id, url, name, userinfo, webPage, interval, updatedAt, notes }
  servers: [], // распарсенные узлы + subId
  selectedId: 'auto',
  settings: { ...defaultSettings },
};
const pings = {};
let status = 'off'; // off | connecting | on | error
let userStopping = false;
let connectedAt = 0;
let lastConfig = null;
const secret = crypto.getRandomValues(new Uint32Array(4)).join('');
const selfExe = await invoke('self_exe_name').catch(() => '');

try {
  const saved = JSON.parse((await invoke('load_state')) || 'null');
  if (saved) {
    Object.assign(state, saved);
    state.settings = { ...defaultSettings, ...saved.settings };
  }
} catch (e) {
  console.error(e);
}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => invoke('save_state', { state: JSON.stringify(state) }).catch((e) => toast(String(e), 'err')), 300);
}

// ---------- Утилиты интерфейса ----------
function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}

function fmtBytes(n, speed = false) {
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}${speed ? '/с' : ''}`;
}

function flagHtml(code, cls = '') {
  if (code === 'auto') return `<span class="flag text auto ${cls}">A</span>`;
  if (!code) return `<span class="flag text ${cls}">··</span>`;
  return `<img class="flag ${cls}" src="https://flagcdn.com/w80/${code}.png" alt="${code}" onerror="this.outerHTML='<span class=&quot;flag text ${cls}&quot;>${code}</span>'">`;
}

function pingHtml(id) {
  const p = pings[id];
  if (p === undefined) return '<span class="ping">—</span>';
  if (p === 'wait') return '<span class="ping">···</span>';
  if (p < 0) return '<span class="ping bad">нет</span>';
  return `<span class="ping ${p < 150 ? 'good' : p < 350 ? 'mid' : 'bad'}">${p} мс</span>`;
}

function describe(srv) {
  const parts = [srv.protocol.toUpperCase()];
  if (srv.security && srv.security !== 'none') parts.push(srv.security === 'reality' ? 'Reality' : srv.security.toUpperCase());
  if (srv.network) parts.push(srv.network);
  return parts.join(' · ');
}

const usable = () => state.servers.filter((s) => !s.info && !s.unsupported);

function openModal(html) {
  $('#modal-box').innerHTML = html;
  $('#modal').hidden = false;
  return $('#modal-box');
}
function closeModal() { $('#modal').hidden = true; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ---------- Навигация ----------
const ICONS = {
  home: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  servers: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  routing: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H15a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6h6.5"/>',
  apps: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  logs: '<path d="M5 6h14M5 11h14M5 16h9"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
};
const PAGES = [
  ['home', 'Подключение'], ['servers', 'Серверы'], ['routing', 'Маршрутизация'],
  ['apps', 'Приложения'], ['logs', 'Журнал'], ['settings', 'Настройки'],
];
$('#nav').innerHTML = PAGES.map(([id, title]) =>
  `<button class="nav-btn" data-page="${id}"><svg viewBox="0 0 24 24">${ICONS[id]}</svg>${title}</button>`).join('')
  + '<div class="side-foot" id="side-foot"></div>';

function renderSideFoot() {
  const s = state.settings;
  $('#side-foot').innerHTML = [
    ['Режим', s.mode === 'tun' ? 'TUN' : 'Прокси'],
    ['Маршруты', s.routing === 'rules' ? 'По правилам' : 'Глобально'],
    ['Сайты РФ', s.ruDomains ? 'Напрямую' : 'Через VPN'],
    ['Порт', s.proxyPort],
  ].map(([k, v]) => `<span>${k}<b>${esc(v)}</b></span>`).join('');
}

// Шкала вокруг кнопки: 60 делений, каждое пятое — длинное.
$('#ticks').innerHTML = Array.from({ length: 60 }, (_, i) => {
  const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
  const major = i % 5 === 0;
  const x = (r) => (125 + Math.cos(a) * r).toFixed(1);
  const y = (r) => (125 + Math.sin(a) * r).toFixed(1);
  const r2 = major ? 106 : 113;
  return `<line class="${major ? 'major' : ''}" x1="${x(124)}" y1="${y(124)}" x2="${x(r2)}" y2="${y(r2)}" />`;
}).join('');
let sweep;
function animateTicks(on) {
  clearInterval(sweep);
  const lines = $$('#ticks line');
  lines.forEach((l) => l.classList.remove('lit'));
  if (!on) return;
  let i = 0;
  sweep = setInterval(() => {
    lines.forEach((l, k) => l.classList.toggle('lit', (i - k + 60) % 60 < 12));
    i = (i + 1) % 60;
  }, 30);
}

function go(page) {
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  if (page === 'logs') scrollLogs();
}
$('#nav').addEventListener('click', (e) => { const b = e.target.closest('.nav-btn'); if (b) go(b.dataset.page); });
document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) go(g.dataset.goto); });

$('#win-min').onclick = () => win.minimize();
$('#win-close').onclick = () => win.hide();
$('#quit').onclick = () => invoke('quit_app');

// ---------- Сегментные переключатели и настройки ----------
const RECONNECT_KEYS = new Set(Object.keys(defaultSettings).filter((k) => !['autoConnect', 'autostart'].includes(k)));

function setSetting(key, value) {
  if (state.settings[key] === value) return;
  state.settings[key] = value;
  save();
  renderAll();
  if (RECONNECT_KEYS.has(key) && status === 'on') scheduleReconnect();
}

function bindSeg(el, key) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setSetting(key, b.dataset.v);
  });
}
bindSeg($('#home-mode'), 'mode');
bindSeg($('#set-mode'), 'mode');
bindSeg($('#routing-mode'), 'routing');
bindSeg($('#app-mode'), 'appMode');

for (const el of $$('[data-setting]')) {
  const key = el.dataset.setting;
  el.addEventListener('change', () => {
    let v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    if (typeof v === 'string' && el.tagName !== 'TEXTAREA') v = v.trim();
    setSetting(key, v);
  });
}
$('#q-ru').addEventListener('change', (e) => {
  state.settings.ruGeosite = e.target.checked;
  setSetting('ruDomains', e.target.checked);
});

$('#set-autostart').addEventListener('change', async (e) => {
  try {
    await invoke('set_autostart', { enable: e.target.checked });
    state.settings.autostart = e.target.checked;
    save();
    toast(e.target.checked ? 'Aurora будет запускаться вместе с Windows' : 'Автозапуск выключен', 'ok');
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(String(err), 'err');
  }
});

let reconnectTimer;
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    toast('Применяю настройки…');
    await connect();
  }, 700);
}

// ---------- Отрисовка ----------
function renderSettingsControls() {
  const s = state.settings;
  for (const [sel, key] of [['#home-mode', 'mode'], ['#set-mode', 'mode'], ['#routing-mode', 'routing'], ['#app-mode', 'appMode']]) {
    $$('button', $(sel)).forEach((b) => b.classList.toggle('on', b.dataset.v === s[key]));
  }
  for (const el of $$('[data-setting]')) {
    if (document.activeElement === el) continue;
    const v = s[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '';
  }
  $('#q-ru').checked = s.ruDomains;
  $('#set-autostart').checked = s.autostart;
}

function currentServer() {
  if (state.selectedId === 'auto') return null;
  return state.servers.find((x) => x.id === state.selectedId);
}

function renderHome() {
  const srv = currentServer();
  const list = usable();
  $('#home-server').innerHTML = !list.length
    ? `${flagHtml('')}<div class="meta"><b>Нет серверов</b><small>Добавьте подписку на вкладке «Серверы»</small></div><span class="chev">›</span>`
    : srv
      ? `${flagHtml(srv.flag)}<div class="meta"><b>${esc(srv.name)}</b><small>${esc(describe(srv))}</small></div>${pingHtml(srv.id)}<span class="chev">›</span>`
      : `${flagHtml('auto')}<div class="meta"><b>Автовыбор</b><small>Самый быстрый из ${list.length} серверов</small></div><span class="chev">›</span>`;

  const s = state.settings;
  const n = s.apps.length;
  $('#q-apps').textContent = s.appMode === 'off' || !n ? 'Все через VPN'
    : s.appMode === 'bypass' ? `${n} ${plural(n, 'программа', 'программы', 'программ')} мимо VPN`
      : `Только ${n} ${plural(n, 'программа', 'программы', 'программ')} через VPN`;

  const cls = status === 'on' ? 'connected' : status;
  if (document.body.className !== cls) {
    document.body.className = cls;
    animateTicks(status === 'connecting');
  }
  renderSideFoot();
  const text = { off: 'Не подключено', connecting: 'Подключение…', on: 'Защищено', error: 'Ошибка' }[status];
  $('#status-text').textContent = text;
  if (status !== 'on') {
    $('#status-sub').textContent = { off: 'Нажмите, чтобы подключиться', connecting: 'Запуск туннеля', error: 'Подробности в журнале' }[status];
  }
}

function plural(n, a, b, c) {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c;
}

const REFRESH_SVG = '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
const LINK_SVG = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

function renderServers() {
  $('#subs').innerHTML = state.subs.map((sub) => {
    const u = sub.userinfo;
    const count = state.servers.filter((x) => x.subId === sub.id && !x.info).length;
    let usage = '';
    if (u) {
      const used = u.upload + u.download;
      const pct = u.total ? Math.min(100, (used / u.total) * 100) : 0;
      const left = u.expire ? Math.ceil((u.expire * 1000 - Date.now()) / 864e5) : null;
      const exp = u.expire
        ? `до ${new Date(u.expire * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })}${left !== null ? ` · ${left > 0 ? `осталось ${left} ${plural(left, 'день', 'дня', 'дней')}` : 'истекла'}` : ''}`
        : 'бессрочно';
      usage = `<div class="usage">${u.total ? `<div class="usage-bar"><i style="width:${pct}%"></i></div>` : ''}
        <div class="usage-meta"><span>${fmtBytes(used)} из ${u.total ? fmtBytes(u.total) : '∞'}</span><span>${exp}</span></div></div>`;
    }
    const notes = (sub.notes || []).map((n) => `<span class="tag">${esc(n)}</span>`).join('');
    return `<div class="card sub-card"><div class="sub-top">
        <div class="meta"><b>${esc(sub.name)}</b><small>${count} ${plural(count, 'сервер', 'сервера', 'серверов')} · обновлено ${sub.updatedAt ? new Date(sub.updatedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'никогда'}</small></div>
        ${sub.webPage ? `<button class="icon-btn" title="Личный кабинет" data-open="${esc(sub.webPage)}">${LINK_SVG}</button>` : ''}
        <button class="icon-btn" title="Обновить" data-refresh="${sub.id}">${REFRESH_SVG}</button>
        <button class="icon-btn" title="Удалить" data-del-sub="${sub.id}">${TRASH_SVG}</button>
      </div>${usage}${notes ? `<div class="notes">${notes}</div>` : ''}</div>`;
  }).join('');

  const list = state.servers.filter((x) => !x.info);
  if (!list.length) {
    $('#server-list').innerHTML = `<div class="empty"><b>Серверов пока нет</b>Нажмите «+ Добавить» и вставьте ссылку на подписку или vless://</div>`;
    return;
  }
  const sorted = [...list].sort((a, b) => {
    if (!!a.unsupported !== !!b.unsupported) return a.unsupported ? 1 : -1;
    const pa = typeof pings[a.id] === 'number' && pings[a.id] >= 0 ? pings[a.id] : 1e9;
    const pb = typeof pings[b.id] === 'number' && pings[b.id] >= 0 ? pings[b.id] : 1e9;
    return pa - pb;
  });
  const auto = `<div class="srv ${state.selectedId === 'auto' ? 'sel' : ''}" data-id="auto">${flagHtml('auto')}
    <div class="meta"><b>Автовыбор</b><small>Ядро само выбирает самый быстрый сервер и переключается при сбое</small></div><span class="check"></span></div>`;
  $('#server-list').innerHTML = auto + sorted.map((x) => `
    <div class="srv ${x.id === state.selectedId ? 'sel' : ''} ${x.unsupported ? 'off' : ''}" data-id="${x.id}" title="${esc(x.unsupported || '')}">
      ${flagHtml(x.flag)}
      <div class="meta"><b>${esc(x.name)}</b><small>${esc(x.unsupported || describe(x))}</small></div>
      ${pingHtml(x.id)}<span class="check"></span>
    </div>`).join('');
}

function renderApps() {
  const s = state.settings;
  $('#apps-hint').textContent = {
    off: 'Весь трафик всех программ идёт по общим правилам',
    bypass: 'Выбранные программы ходят в интернет напрямую, остальные — через VPN',
    only: 'Через VPN идут только выбранные программы, всё остальное — напрямую',
  }[s.appMode];
  $('#app-list').innerHTML = s.apps.length
    ? s.apps.map((a) => `<div class="card app-item"><span class="app-ico">${esc(a[0].toUpperCase())}</span><span title="${esc(a)}">${esc(a)}</span>
        <button class="icon-btn" data-del-app="${esc(a)}" title="Убрать">${TRASH_SVG}</button></div>`).join('')
    : `<div class="empty" style="grid-column:1/-1"><b>Список пуст</b>Добавьте программы, например Telegram.exe или steam.exe</div>`;
}

function renderAll() {
  renderSettingsControls();
  renderHome();
  renderServers();
  renderApps();
}

// ---------- Серверы: события ----------
$('#server-list').addEventListener('click', (e) => {
  const el = e.target.closest('.srv');
  if (!el || el.classList.contains('off')) return;
  if (state.selectedId === el.dataset.id) return;
  state.selectedId = el.dataset.id;
  save();
  renderAll();
  if (status === 'on') scheduleReconnect();
});

$('#subs').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.refresh) {
    b.classList.add('spin');
    await updateSub(state.subs.find((s) => s.id === b.dataset.refresh)).catch((err) => toast(`Подписка: ${err}`, 'err'));
    renderAll();
  } else if (b.dataset.delSub) {
    if (!confirm('Удалить подписку и её серверы?')) return;
    state.subs = state.subs.filter((s) => s.id !== b.dataset.delSub);
    state.servers = state.servers.filter((s) => s.subId !== b.dataset.delSub);
    save();
    renderAll();
  } else if (b.dataset.open) {
    invoke('open_url', { url: b.dataset.open }).catch(() => window.open(b.dataset.open));
  }
});

$('#home-server').onclick = () => go('servers');

$('#add-sub').onclick = () => {
  const box = openModal(`<h3>Добавить подписку или сервер</h3>
    <p>Вставьте ссылку на подписку (https://…) или одну/несколько ссылок vless://, trojan://, ss://, hy2://</p>
    <textarea class="input" id="sub-input" placeholder="https://… или vless://…" spellcheck="false"></textarea>
    <div class="modal-actions"><button class="btn ghost" id="m-cancel">Отмена</button><button class="btn" id="m-ok">Добавить</button></div>`);
  const input = $('#sub-input', box);
  input.focus();
  $('#m-cancel', box).onclick = closeModal;
  $('#m-ok', box).onclick = async () => {
    const text = input.value.trim();
    if (!text) return;
    $('#m-ok', box).disabled = true;
    try {
      if (/^https?:\/\//i.test(text)) {
        const sub = { id: hash(text), url: text, name: new URL(text).hostname, notes: [] };
        if (state.subs.some((s) => s.id === sub.id)) throw new Error('Эта подписка уже добавлена');
        await updateSub(sub);
        state.subs.push(sub);
        toast(`Подписка «${sub.name}» добавлена`, 'ok');
      } else {
        const { servers, errors } = parseSubscription(text);
        if (!servers.length) throw new Error(errors[0] || 'Не удалось распознать ссылку');
        const known = new Set(state.servers.map((s) => s.id));
        state.servers.push(...servers.filter((s) => !known.has(s.id)).map((s) => ({ ...s, subId: 'manual' })));
        toast(`Добавлено серверов: ${servers.length}`, 'ok');
      }
      save();
      closeModal();
      renderAll();
      pingAll();
    } catch (err) {
      toast(String(err.message || err), 'err');
      $('#m-ok', box).disabled = false;
    }
  };
};

async function updateSub(sub) {
  let res = await invoke('fetch_subscription', { url: sub.url, userAgent: 'v2rayN/7.0' });
  if (res.status >= 400) throw new Error(`сервер ответил ${res.status}`);
  let parsed = parseSubscription(res.body);
  if (!parsed.servers.length) {
    // Некоторые панели отдают формат в зависимости от User-Agent.
    const alt = await invoke('fetch_subscription', { url: sub.url, userAgent: 'sing-box/1.14.4' });
    const altParsed = parseSubscription(alt.body);
    if (altParsed.servers.length) { res = alt; parsed = altParsed; }
  }
  if (!parsed.servers.length) throw new Error(parsed.errors[0] || 'в подписке нет серверов');
  const h = res.headers;
  sub.name = parseTitle(h['profile-title']) || sub.name;
  sub.userinfo = parseUserinfo(h['subscription-userinfo']);
  sub.webPage = h['profile-web-page-url'] || h['support-url'] || '';
  sub.interval = Number(h['profile-update-interval']) || 12;
  sub.updatedAt = Date.now();
  sub.notes = parsed.servers.filter((s) => s.info).map((s) => s.name);
  state.servers = state.servers.filter((s) => s.subId !== sub.id)
    .concat(parsed.servers.map((s) => ({ ...s, subId: sub.id })));
  if (state.selectedId !== 'auto' && !state.servers.some((s) => s.id === state.selectedId)) state.selectedId = 'auto';
  save();
}

async function updateAllSubs(onlyStale = false) {
  for (const sub of state.subs) {
    if (onlyStale && sub.updatedAt && Date.now() - sub.updatedAt < (sub.interval || 12) * 36e5) continue;
    await updateSub(sub).catch((e) => toast(`${sub.name}: ${e.message || e}`, 'err'));
  }
  renderAll();
}
$('#update-subs').onclick = async (e) => {
  e.target.disabled = true;
  await updateAllSubs();
  e.target.disabled = false;
  toast('Подписки обновлены', 'ok');
};

async function pingAll() {
  const list = usable();
  list.forEach((s) => { pings[s.id] = 'wait'; });
  renderServers();
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const s = list[i++];
      pings[s.id] = s.protocol === 'hysteria2'
        ? undefined
        : await invoke('tcp_ping', { host: s.host, port: s.port }).catch(() => -1);
      renderServers();
      renderHome();
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
}
$('#ping-all').onclick = pingAll;

// ---------- Приложения ----------
$('#app-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del-app]');
  if (!b) return;
  setSetting('apps', state.settings.apps.filter((a) => a !== b.dataset.delApp));
});

$('#add-app').onclick = async () => {
  const box = openModal(`<h3>Добавить программу</h3>
    <p>Выберите из запущенных или введите имя исполняемого файла (например, <code>Telegram.exe</code>).</p>
    <div style="display:flex;gap:8px"><input class="input" id="proc-q" placeholder="Поиск или имя .exe" /><button class="btn" id="proc-add">Добавить</button></div>
    <div class="proc-list" id="proc-list"><p>Загрузка списка процессов…</p></div>
    <div class="modal-actions"><button class="btn ghost" id="m-close">Готово</button></div>`);
  $('#m-close', box).onclick = closeModal;
  const q = $('#proc-q', box);
  q.focus();
  const add = (name) => {
    name = name.trim();
    if (!name) return;
    if (!/\.exe$/i.test(name)) name += '.exe';
    if (state.settings.apps.some((a) => a.toLowerCase() === name.toLowerCase())) return;
    if (state.settings.appMode === 'off') state.settings.appMode = 'bypass';
    setSetting('apps', [...state.settings.apps, name]);
    draw();
  };
  $('#proc-add', box).onclick = () => { add(q.value); q.value = ''; draw(); };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#proc-add', box).click(); });
  const SYSTEM = /^(system|registry|smss|csrss|wininit|services|lsass|svchost|fontdrvhost|dwm|winlogon|conhost|sihost|ctfmon|taskhostw|runtimebroker|searchhost|startmenuexperiencehost|textinputhost|shellexperiencehost|dllhost|wmiprvse|spoolsv|memory compression|secure system|idle|system idle process|sing-box)(\.exe)?$/i;
  let procs = [];
  const draw = () => {
    const f = q.value.toLowerCase();
    const picked = new Set(state.settings.apps.map((a) => a.toLowerCase()));
    $('#proc-list', box).innerHTML = procs.filter((p) => p.toLowerCase().includes(f)).map((p) =>
      `<button data-p="${esc(p)}" class="${picked.has(p.toLowerCase()) ? 'picked' : ''}"><span>${esc(p)}</span><span>${picked.has(p.toLowerCase()) ? '✓' : '+'}</span></button>`).join('') || '<p>Ничего не найдено — нажмите «Добавить», чтобы указать вручную</p>';
  };
  q.addEventListener('input', draw);
  $('#proc-list', box).addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) add(b.dataset.p); });
  procs = (await invoke('list_processes').catch(() => [])).filter((p) => !SYSTEM.test(p) && p !== selfExe);
  draw();
};

// ---------- Подключение ----------
async function connect() {
  clearTimeout(reconnectTimer);
  status = 'connecting';
  renderHome();
  try {
    lastConfig = buildConfig({ servers: state.servers, selectedId: state.selectedId, settings: state.settings, secret, selfExe });
    userStopping = true;
    stopTraffic();
    await invoke('start_core', { config: JSON.stringify(lastConfig, null, 2) });
    userStopping = false;
    await waitForApi();
    status = 'on';
    connectedAt = Date.now();
    startTraffic();
    invoke('set_tray_state', { connected: true, label: currentServer()?.name || 'Автовыбор' }).catch(() => {});
  } catch (e) {
    userStopping = false;
    status = 'error';
    log(`[aurora] ${e.message || e}`, 'e');
    toast(String(e.message || e).split('\n')[0], 'err');
    await invoke('stop_core').catch(() => {});
  }
  renderHome();
}

async function disconnect() {
  userStopping = true;
  stopTraffic();
  await invoke('stop_core').catch(() => {});
  status = 'off';
  invoke('set_tray_state', { connected: false, label: '' }).catch(() => {});
  renderHome();
}

function toggle() {
  if (status === 'on' || status === 'connecting') disconnect(); else connect();
}
$('#connect').onclick = toggle;
listen('tray-toggle', toggle);

listen('core-exit', (e) => {
  if (userStopping) return;
  const was = status;
  stopTraffic();
  status = 'error';
  log(`[aurora] ядро остановилось (код ${e.payload ?? '?'})`, 'e');
  if (was === 'on') toast('Ядро sing-box остановилось — подробности в журнале', 'err');
  invoke('set_tray_state', { connected: false, label: '' }).catch(() => {});
  renderHome();
});

function waitForApi() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      if (status !== 'connecting') return reject(new Error('Ядро не запустилось'));
      const ws = bridge.ws ? bridge.ws('version') : new WebSocket(`ws://127.0.0.1:${API_PORT}/traffic?token=${secret}`);
      ws.onopen = () => { ws.close(); resolve(); };
      ws.onerror = () => {
        if (Date.now() - started > 15000) reject(new Error('Ядро не отвечает — проверьте журнал'));
        else setTimeout(attempt, 400);
      };
    };
    attempt();
  });
}

// ---------- Трафик ----------
const history = { down: Array(60).fill(0), up: Array(60).fill(0) };
let trafficWs, connWs, clock;

function openWs(path, onmsg) {
  const ws = bridge.ws ? bridge.ws(path) : new WebSocket(`ws://127.0.0.1:${API_PORT}/${path}${path.includes('?') ? '&' : '?'}token=${secret}`);
  ws.onmessage = (e) => { try { onmsg(JSON.parse(e.data)); } catch {} };
  return ws;
}

function startTraffic() {
  trafficWs = openWs('traffic', (d) => {
    history.down.push(d.down); history.down.shift();
    history.up.push(d.up); history.up.shift();
    $('#st-down').textContent = fmtBytes(d.down, true);
    $('#st-up').textContent = fmtBytes(d.up, true);
    drawGraph();
  });
  connWs = openWs('connections?interval=1000', (d) => {
    $('#st-down-total').textContent = `всего ${fmtBytes(d.downloadTotal || 0)}`;
    $('#st-up-total').textContent = `всего ${fmtBytes(d.uploadTotal || 0)}`;
    const n = (d.connections || []).length;
    $('#st-conns').textContent = `${n} ${plural(n, 'соединение', 'соединения', 'соединений')}`;
  });
  clock = setInterval(() => {
    const t = Math.floor((Date.now() - connectedAt) / 1000);
    const hh = String(Math.floor(t / 3600)).padStart(2, '0');
    const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
    const ss = String(t % 60).padStart(2, '0');
    $('#status-sub').textContent = `${hh}:${mm}:${ss} · ${state.settings.mode === 'tun' ? 'TUN' : 'прокси'} · ${state.settings.routing === 'rules' ? 'по правилам' : 'глобально'}`;
  }, 1000);
}

function stopTraffic() {
  trafficWs?.close(); connWs?.close(); clearInterval(clock);
  history.down.fill(0); history.up.fill(0);
  $('#st-down').textContent = $('#st-up').textContent = '0 Б/с';
  $('#st-conns').textContent = '0 соединений';
  drawGraph();
}

function drawGraph() {
  const c = $('#graph');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  // Две тонкие сглаженные линии с лёгкой заливкой.
  const max = Math.max(32 * 1024, ...history.down, ...history.up) * 1.15;
  for (const [data, color] of [[history.up, col('--accent')], [history.down, col('--blue')]]) {
    const step = w / (data.length - 1);
    const y = (v) => h - 3 - (v / max) * (h - 8);
    g.beginPath();
    g.moveTo(0, y(data[0]));
    for (let i = 1; i < data.length; i++) {
      const x0 = (i - 1) * step, x1 = i * step;
      g.bezierCurveTo(x0 + step / 2, y(data[i - 1]), x1 - step / 2, y(data[i]), x1, y(data[i]));
    }
    g.strokeStyle = color;
    g.lineWidth = 1.6;
    g.stroke();
    g.lineTo(w, h); g.lineTo(0, h); g.closePath();
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color + '33');
    grad.addColorStop(1, color + '00');
    g.fillStyle = grad;
    g.fill();
  }
}
window.addEventListener('resize', drawGraph);

// ---------- Журнал ----------
const logLines = [];
function log(line, cls) {
  if (!cls) cls = /\bERROR|FATAL/.test(line) ? 'e' : /\bWARN/.test(line) ? 'w' : /\bDEBUG|TRACE/.test(line) ? 'd' : '';
  logLines.push({ line, cls });
  if (logLines.length > 1500) logLines.splice(0, 300);
  if ($('#page-logs').classList.contains('active')) scheduleLogRender();
}
let logFrame;
function scheduleLogRender() {
  cancelAnimationFrame(logFrame);
  logFrame = requestAnimationFrame(scrollLogs);
}
function scrollLogs() {
  const f = $('#log-filter').value.toLowerCase();
  const el = $('#logs');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = logLines.filter((l) => !f || l.line.toLowerCase().includes(f)).slice(-800)
    .map((l) => `<span class="${l.cls}">${esc(l.line)}</span>`).join('\n');
  if (atBottom) el.scrollTop = el.scrollHeight;
}
listen('core-log', (e) => log(e.payload));
$('#log-filter').addEventListener('input', scrollLogs);
$('#clear-logs').onclick = () => { logLines.length = 0; scrollLogs(); };
$('#copy-logs').onclick = async () => {
  await navigator.clipboard.writeText(logLines.map((l) => l.line).join('\n'));
  toast('Журнал скопирован', 'ok');
};
$('#show-config').onclick = () => {
  let cfg = lastConfig;
  try { cfg = cfg || buildConfig({ servers: state.servers, selectedId: state.selectedId, settings: state.settings, secret: '***', selfExe }); } catch (e) { return toast(e.message, 'err'); }
  // Ключи и пароли в просмотре скрываем.
  const masked = JSON.stringify(cfg, (k, v) => (['uuid', 'password', 'public_key', 'secret'].includes(k) ? '•••' : v), 2);
  const box = openModal(`<h3>Конфиг sing-box</h3><pre>${esc(masked)}</pre><div class="modal-actions"><button class="btn" id="m-close">Закрыть</button></div>`);
  $('#m-close', box).onclick = closeModal;
};

// ---------- Старт ----------
go('home');
renderAll();
drawGraph();
invoke('core_version').then((v) => { $('#about-core').textContent = v; }).catch(() => {});

if (state.subs.length) updateAllSubs(true).then(pingAll); else pingAll();
setInterval(() => updateAllSubs(true), 30 * 60 * 1000);

if (state.settings.autoConnect && usable().length) connect();
