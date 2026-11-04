// Разбор подписок и ссылок (vless/vmess/trojan/ss/hysteria2) в outbound'ы sing-box.

const FINGERPRINTS = ['chrome', 'firefox', 'edge', 'safari', '360', 'qq', 'ios', 'android', 'random', 'randomized'];

export function b64decode(input) {
  let s = input.trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// Флаг-эмодзи → ISO-код (на Windows эмодзи-флаги не рисуются, поэтому показываем картинку).
export function extractFlag(name) {
  const m = name.match(/([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/u);
  if (!m) return { code: '', title: name.trim() };
  const code = [m[1], m[2]].map((c) => String.fromCharCode(c.codePointAt(0) - 0x1f1e6 + 97)).join('');
  return { code, title: name.replace(m[0], '').replace(/\s{2,}/g, ' ').trim() };
}

function splitHostPort(s) {
  const m = s.match(/^\[([^\]]+)\]:(\d+)$/) || s.match(/^([^:]+):(\d+)$/);
  if (!m) throw new Error(`неверный адрес ${s}`);
  return { host: m[1], port: Number(m[2]) };
}

function parseUrl(link) {
  const u = new URL(link);
  const user = safeDecode(u.username) + (u.password ? ':' + safeDecode(u.password) : '');
  return {
    user,
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: Number(u.port),
    params: u.searchParams,
    name: safeDecode(u.hash.slice(1)),
  };
}

function normalizeFp(fp) {
  fp = (fp || '').toLowerCase();
  return FINGERPRINTS.includes(fp) ? fp : 'chrome';
}

function buildTls(p, host, defaultSecurity = 'none') {
  const security = (p.get('security') || defaultSecurity).toLowerCase();
  if (security !== 'tls' && security !== 'reality') return { security: 'none' };
  const tls = { enabled: true, server_name: p.get('sni') || p.get('peer') || host };
  if (['1', 'true'].includes(p.get('allowInsecure') || p.get('insecure'))) tls.insecure = true;
  const alpn = p.get('alpn');
  if (alpn) tls.alpn = alpn.split(',').map((s) => s.trim()).filter(Boolean);
  const fp = p.get('fp');
  if (fp || security === 'reality') tls.utls = { enabled: true, fingerprint: normalizeFp(fp) };
  if (security === 'reality') {
    if (!p.get('pbk')) throw new Error('reality без pbk');
    tls.reality = { enabled: true, public_key: p.get('pbk'), short_id: p.get('sid') || '' };
  }
  return { security, tls };
}

function buildTransport(p) {
  const type = (p.get('type') || 'tcp').toLowerCase();
  const host = p.get('host');
  const path = p.get('path') || '/';
  switch (type) {
    case 'tcp':
    case 'raw':
      return { network: 'tcp' };
    case 'ws': {
      const t = { type: 'ws', path };
      if (host) t.headers = { Host: host };
      const ed = path.match(/[?&]ed=(\d+)/);
      if (ed) {
        t.max_early_data = Number(ed[1]);
        t.early_data_header_name = 'Sec-WebSocket-Protocol';
        t.path = path.replace(/[?&]ed=\d+/, '').replace(/\?$/, '') || '/';
      }
      return { network: 'ws', transport: t };
    }
    case 'grpc':
      return { network: 'grpc', transport: { type: 'grpc', service_name: p.get('serviceName') || p.get('path') || '' } };
    case 'http':
    case 'h2': {
      const t = { type: 'http', path };
      if (host) t.host = host.split(',').map((s) => s.trim());
      return { network: 'h2', transport: t };
    }
    case 'httpupgrade': {
      const t = { type: 'httpupgrade', path };
      if (host) t.host = host;
      return { network: 'httpupgrade', transport: t };
    }
    case 'quic':
      return { network: 'quic', transport: { type: 'quic' } };
    default:
      return { network: type, unsupported: `транспорт ${type} не поддерживается ядром sing-box` };
  }
}

function parseVless(link) {
  const { user, host, port, params: p, name } = parseUrl(link);
  const { security, tls } = buildTls(p, host);
  const { network, transport, unsupported } = buildTransport(p);
  const outbound = { type: 'vless', server: host, server_port: port, uuid: user, packet_encoding: 'xudp' };
  const flow = p.get('flow');
  if (flow && network === 'tcp' && tls) outbound.flow = 'xtls-rprx-vision';
  if (tls) outbound.tls = tls;
  if (transport) outbound.transport = transport;
  return { name, host, port, protocol: 'vless', security, network, outbound, unsupported };
}

function parseTrojan(link) {
  const { user, host, port, params: p, name } = parseUrl(link);
  const { security, tls } = buildTls(p, host, 'tls');
  const { network, transport, unsupported } = buildTransport(p);
  const outbound = { type: 'trojan', server: host, server_port: port, password: user };
  if (tls) outbound.tls = tls;
  if (transport) outbound.transport = transport;
  return { name, host, port, protocol: 'trojan', security, network, outbound, unsupported };
}

function parseVmess(link) {
  const j = JSON.parse(b64decode(link.slice('vmess://'.length)));
  const p = new URLSearchParams();
  const set = (k, v) => v !== undefined && v !== null && v !== '' && p.set(k, String(v));
  set('type', j.net || 'tcp');
  set('host', j.host);
  set('path', j.path);
  if (j.net === 'grpc') set('serviceName', j.path);
  set('security', j.tls === 'tls' ? 'tls' : 'none');
  set('sni', j.sni);
  set('alpn', j.alpn);
  set('fp', j.fp);
  const host = String(j.add);
  const port = Number(j.port);
  const { security, tls } = buildTls(p, host);
  const { network, transport, unsupported } = buildTransport(p);
  const outbound = {
    type: 'vmess', server: host, server_port: port, uuid: j.id,
    security: j.scy || 'auto', alter_id: Number(j.aid) || 0, packet_encoding: 'xudp',
  };
  if (tls) outbound.tls = tls;
  if (transport) outbound.transport = transport;
  return { name: j.ps || '', host, port, protocol: 'vmess', security, network, outbound, unsupported };
}

function parseShadowsocks(link) {
  let rest = link.slice('ss://'.length);
  let name = '';
  const hashAt = rest.indexOf('#');
  if (hashAt >= 0) { name = safeDecode(rest.slice(hashAt + 1)); rest = rest.slice(0, hashAt); }
  let query = '';
  const qAt = rest.indexOf('?');
  if (qAt >= 0) { query = rest.slice(qAt + 1); rest = rest.slice(0, qAt); }
  rest = rest.replace(/\/$/, '');
  if (!rest.includes('@')) rest = b64decode(rest);
  const at = rest.lastIndexOf('@');
  let userinfo = safeDecode(rest.slice(0, at));
  if (!userinfo.includes(':')) userinfo = b64decode(userinfo);
  const colon = userinfo.indexOf(':');
  const { host, port } = splitHostPort(rest.slice(at + 1));
  const outbound = {
    type: 'shadowsocks', server: host, server_port: port,
    method: userinfo.slice(0, colon), password: userinfo.slice(colon + 1),
  };
  const plugin = new URLSearchParams(query).get('plugin');
  if (plugin) {
    const [pname, ...opts] = plugin.split(';');
    outbound.plugin = pname === 'simple-obfs' ? 'obfs-local' : pname;
    outbound.plugin_opts = opts.join(';');
  }
  return { name, host, port, protocol: 'ss', security: outbound.method, network: 'tcp', outbound };
}

function parseHysteria2(link) {
  const { user, host, port, params: p, name } = parseUrl(link.replace(/^hy2:/, 'hysteria2:'));
  const tls = { enabled: true, server_name: p.get('sni') || host };
  if (['1', 'true'].includes(p.get('insecure'))) tls.insecure = true;
  const alpn = p.get('alpn');
  if (alpn) tls.alpn = alpn.split(',');
  const outbound = { type: 'hysteria2', server: host, server_port: port || 443, password: user, tls };
  if (p.get('obfs') === 'salamander') outbound.obfs = { type: 'salamander', password: p.get('obfs-password') || '' };
  return { name, host, port: port || 443, protocol: 'hysteria2', security: 'tls', network: 'udp', outbound };
}

const PARSERS = {
  vless: parseVless,
  vmess: parseVmess,
  trojan: parseTrojan,
  ss: parseShadowsocks,
  hysteria2: parseHysteria2,
  hy2: parseHysteria2,
};

// Панели (Remnawave, Marzban, 3x-ui) часто кладут в подписку «фейковые» узлы с текстом
// вроде «Осталось 30 дней» — показываем их как заметки, а не как серверы.
function isInfoNode(host, port) {
  return ['0.0.0.0', '127.0.0.1', '1.1.1.1', 'localhost'].includes(host) && port <= 2;
}

function finalize(raw, sourceKey) {
  const { code, title } = extractFlag(raw.name || `${raw.host}:${raw.port}`);
  return {
    id: hash(sourceKey),
    name: title || `${raw.host}:${raw.port}`,
    flag: code,
    protocol: raw.protocol,
    security: raw.security,
    network: raw.network,
    host: raw.host,
    port: raw.port,
    outbound: raw.outbound,
    unsupported: raw.unsupported || null,
    info: isInfoNode(raw.host, raw.port),
  };
}

export function parseLink(link) {
  link = link.trim();
  const scheme = link.slice(0, link.indexOf('://')).toLowerCase();
  const parser = PARSERS[scheme];
  if (!parser) throw new Error(`протокол ${scheme || '?'} не поддерживается`);
  return finalize(parser(link), link);
}

const OUTBOUND_TYPES = ['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic', 'wireguard', 'anytls'];

// Подписка может прийти как base64, как список ссылок или как готовый конфиг sing-box.
export function parseSubscription(body) {
  const text = (body || '').trim();
  const servers = [];
  const errors = [];

  if (text.startsWith('{')) {
    try {
      const json = JSON.parse(text);
      for (const o of json.outbounds || []) {
        if (!OUTBOUND_TYPES.includes(o.type) || !o.server) continue;
        const { tag, ...outbound } = o;
        servers.push(finalize({
          name: tag, host: o.server, port: o.server_port, protocol: o.type,
          security: o.tls?.reality?.enabled ? 'reality' : o.tls?.enabled ? 'tls' : 'none',
          network: o.transport?.type || 'tcp', outbound,
        }, JSON.stringify(o)));
      }
      return { servers, errors };
    } catch (e) {
      errors.push(`JSON: ${e.message}`);
    }
  }

  let content = text;
  if (!text.includes('://')) {
    try { content = b64decode(text); } catch { content = ''; }
  }
  for (const line of content.split(/\r?\n/)) {
    const l = line.trim();
    if (!/^[a-z0-9]+:\/\//i.test(l)) continue;
    try {
      servers.push(parseLink(l));
    } catch (e) {
      errors.push(`${l.slice(0, 40)}…: ${e.message}`);
    }
  }
  return { servers, errors };
}

export function parseUserinfo(header) {
  if (!header) return null;
  const info = {};
  for (const part of header.split(';')) {
    const [k, v] = part.split('=').map((s) => s && s.trim());
    if (k && v !== undefined) info[k] = Number(v) || 0;
  }
  return {
    upload: info.upload || 0,
    download: info.download || 0,
    total: info.total || 0,
    expire: info.expire || 0,
  };
}

export function parseTitle(header) {
  if (!header) return '';
  if (header.startsWith('base64:')) {
    try { return b64decode(header.slice(7)); } catch { return ''; }
  }
  return safeDecode(header);
}
