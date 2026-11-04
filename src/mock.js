// Заглушка Tauri для просмотра интерфейса в обычном браузере (без ядра и сети).
const U = '00000000-0000-0000-0000-000000000000';
const demo = [
  ['nl', 'Нидерланды', 'nl'], ['de', 'Германия', 'de'], ['fi', 'Финляндия', 'fi'],
  ['us', 'США', 'us'], ['tr', 'Турция', 'tr'], ['kz', 'Казахстан', 'kz'],
].map(([cc, name, host]) => {
  const flag = [...cc.toUpperCase()].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join('');
  return `vless://${U}@${host}.demo.invalid:443?type=tcp&security=reality&pbk=demo&sni=www.microsoft.com&flow=xtls-rprx-vision#${encodeURIComponent(flag + ' ' + name)}`;
});
demo.push(`vless://${U}@0.0.0.0:1?type=tcp#${encodeURIComponent('Осталось 27 дней')}`);

const listeners = {};
let state = localStorage.getItem('aurora-demo');

class FakeWs {
  constructor(path) {
    this.path = path;
    setTimeout(() => this.onopen?.(), 300);
    let total = { d: 0, u: 0 };
    this.t = setInterval(() => {
      const down = Math.random() * 2.5e6, up = Math.random() * 3e5;
      total.d += down; total.u += up;
      const data = path.startsWith('traffic') ? { down, up }
        : { downloadTotal: total.d, uploadTotal: total.u, connections: Array(20 + (Math.random() * 15) | 0) };
      this.onmessage?.({ data: JSON.stringify(data) });
    }, 1000);
  }
  close() { clearInterval(this.t); }
}

export const bridge = {
  ws: (path) => new FakeWs(path),
  win: { minimize() {}, hide() {} },
  listen: (ev, cb) => { listeners[ev] = cb; return Promise.resolve(() => {}); },
  invoke: async (cmd, args) => {
    switch (cmd) {
      case 'load_state': return state;
      case 'save_state': state = args.state; localStorage.setItem('aurora-demo', state); return;
      case 'self_exe_name': return 'Aurora VPN.exe';
      case 'core_version': return 'sing-box 1.14.4 (демо-режим)';
      case 'fetch_subscription':
        return {
          status: 200, body: btoa(unescape(encodeURIComponent(demo.join('\n')))),
          headers: {
            'profile-title': 'base64:' + btoa(unescape(encodeURIComponent('Демо-подписка'))),
            'subscription-userinfo': `upload=2147483648; download=40802189312; total=214748364800; expire=${Math.floor(Date.now() / 1000) + 27 * 86400}`,
            'profile-web-page-url': 'https://example.com',
          },
        };
      case 'tcp_ping': await new Promise((r) => setTimeout(r, 200 + Math.random() * 600)); return Math.round(30 + Math.random() * 250);
      case 'list_processes': return ['chrome.exe', 'Discord.exe', 'explorer.exe', 'steam.exe', 'Telegram.exe', 'Code.exe', 'Spotify.exe', 'qbittorrent.exe'];
      case 'start_core':
        setTimeout(() => listeners['core-log']?.({ payload: '+0300 2026-11-04 12:00:00 INFO sing-box started (0.12s)' }), 100);
        return;
      default: return null;
    }
  },
};
