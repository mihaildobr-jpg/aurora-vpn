// Сборка конфига sing-box (формат 1.12+) из выбранного сервера и настроек маршрутизации.

export const API_PORT = 19090;

export const RU_TLDS = ['.ru', '.su', '.xn--p1ai', '.xn--d1acj3b', '.xn--80adxhks', '.moscow', '.tatar', '.xn--80asehdb'];

const RULE_SETS = {
  'geosite-ru': 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ru.srs',
  'geoip-ru': 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-ru.srs',
};

export const defaultSettings = {
  mode: 'tun', // tun | proxy
  routing: 'rules', // rules | global
  ruDomains: true,
  ruGeosite: true,
  ruGeoip: false,
  appMode: 'off', // off | bypass | only
  apps: [],
  directList: '',
  proxyList: '',
  blockList: '',
  dnsRemote: '1.1.1.1',
  dnsDirect: '77.88.8.8',
  stack: 'mixed',
  mtu: 9000,
  ipv6: false,
  proxyPort: 2080,
  logLevel: 'info',
  autoConnect: false,
  autostart: false,
};

const isIp = (s) => /^[\d.]+$/.test(s) || s.includes(':');

// Строка списка: example.com → суффикс, full:x → точный домен, keyword:x, regex:x, 1.2.3.0/24 → IP.
export function parseList(text) {
  const out = { domain: [], domain_suffix: [], domain_keyword: [], domain_regex: [], ip_cidr: [] };
  for (let line of (text || '').split(/[\n,]/)) {
    line = line.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [, prefix, value] = line.match(/^(full|domain|keyword|regex|ip):(.+)$/) || [, '', line];
    if (prefix === 'full' || prefix === 'domain') out.domain.push(value);
    else if (prefix === 'keyword') out.domain_keyword.push(value);
    else if (prefix === 'regex') out.domain_regex.push(value);
    else if (prefix === 'ip' || /^[\d.]+(\/\d+)?$/.test(value) || /^[0-9a-f:]+\/\d+$/i.test(value)) {
      out.ip_cidr.push(value.includes('/') ? value : value + (value.includes(':') ? '/128' : '/32'));
    } else out.domain_suffix.push(value.replace(/^\*\./, '').replace(/^\./, ''));
  }
  return out;
}

// Возвращает 0–2 правила (домены и IP отдельно, чтобы они объединялись через ИЛИ).
function listRules(text, extra) {
  const l = parseList(text);
  const rules = [];
  const domainPart = {};
  for (const k of ['domain', 'domain_suffix', 'domain_keyword', 'domain_regex']) if (l[k].length) domainPart[k] = l[k];
  if (Object.keys(domainPart).length) rules.push({ ...domainPart, ...extra });
  if (l.ip_cidr.length) rules.push({ ip_cidr: l.ip_cidr, ...extra });
  return rules;
}

export function buildConfig({ servers, selectedId, settings, secret, selfExe }) {
  const s = { ...defaultSettings, ...settings };
  const usable = servers.filter((x) => x.outbound && !x.unsupported && !x.info);
  if (!usable.length) throw new Error('Нет доступных серверов — добавьте подписку');

  const outbounds = [];
  if (selectedId === 'auto') {
    const nodes = usable.map((srv, i) => ({ ...srv.outbound, tag: `${i + 1}. ${srv.name}` }));
    outbounds.push({
      type: 'urltest', tag: 'proxy', outbounds: nodes.map((n) => n.tag),
      url: 'https://www.gstatic.com/generate_204', interval: '3m', tolerance: 80,
    }, ...nodes);
  } else {
    const srv = usable.find((x) => x.id === selectedId) || usable[0];
    outbounds.push({ ...srv.outbound, tag: 'proxy' });
  }
  outbounds.push({ type: 'direct', tag: 'direct' });

  const rulesMode = s.routing === 'rules';
  const apps = rulesMode && s.appMode !== 'off' ? s.apps.filter(Boolean) : [];
  const onlyMode = apps.length > 0 && s.appMode === 'only';
  const bypassApps = apps.length > 0 && s.appMode === 'bypass';
  const useGeosite = rulesMode && s.ruGeosite;
  const useGeoip = rulesMode && s.ruGeoip;

  // ---------- DNS ----------
  const remote = { type: 'https', tag: 'dns-remote', server: s.dnsRemote, detour: 'proxy' };
  if (!isIp(s.dnsRemote)) remote.domain_resolver = 'dns-direct';
  const dnsRules = [];
  dnsRules.push(...listRules(s.blockList, { action: 'reject' }).filter((r) => !r.ip_cidr));
  dnsRules.push(...listRules(s.proxyList, { server: 'dns-remote' }).filter((r) => !r.ip_cidr));
  dnsRules.push(...listRules(s.directList, { server: 'dns-direct' }).filter((r) => !r.ip_cidr));
  if (bypassApps) dnsRules.push({ process_name: apps, server: 'dns-direct' });
  if (rulesMode && s.ruDomains) dnsRules.push({ domain_suffix: RU_TLDS, server: 'dns-direct' });
  if (useGeosite) dnsRules.push({ rule_set: ['geosite-ru'], server: 'dns-direct' });
  if (onlyMode) dnsRules.push({ process_name: apps, server: 'dns-remote' });

  const dns = {
    servers: [remote, { type: 'udp', tag: 'dns-direct', server: s.dnsDirect }],
    rules: dnsRules,
    final: onlyMode ? 'dns-direct' : 'dns-remote',
    strategy: s.ipv6 ? 'prefer_ipv4' : 'ipv4_only',
  };

  // ---------- Inbounds ----------
  const inbounds = [];
  if (s.mode === 'tun') {
    inbounds.push({
      type: 'tun', tag: 'tun-in', interface_name: 'Aurora',
      address: s.ipv6 ? ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'] : ['172.19.0.1/30'],
      mtu: Number(s.mtu) || 9000, auto_route: true, strict_route: true, stack: s.stack,
    });
  }
  inbounds.push({
    type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: Number(s.proxyPort) || 2080,
    set_system_proxy: s.mode === 'proxy',
  });

  // ---------- Route ----------
  const rules = [
    { action: 'sniff' },
    { protocol: 'dns', action: 'hijack-dns' },
    { ip_is_private: true, outbound: 'direct' },
  ];
  if (selfExe) rules.push({ process_name: [selfExe], outbound: 'direct' });
  rules.push(...listRules(s.blockList, { action: 'reject' }));
  rules.push(...listRules(s.proxyList, { outbound: 'proxy' }));
  rules.push(...listRules(s.directList, { outbound: 'direct' }));
  if (bypassApps) rules.push({ process_name: apps, outbound: 'direct' });
  if (rulesMode && s.ruDomains) rules.push({ domain_suffix: RU_TLDS, outbound: 'direct' });
  if (useGeosite) rules.push({ rule_set: ['geosite-ru'], outbound: 'direct' });
  if (useGeoip) rules.push({ rule_set: ['geoip-ru'], outbound: 'direct' });
  if (onlyMode) rules.push({ process_name: apps, outbound: 'proxy' });

  const ruleSet = [];
  for (const [tag, on] of [['geosite-ru', useGeosite], ['geoip-ru', useGeoip]]) {
    if (on) ruleSet.push({ type: 'remote', tag, format: 'binary', url: RULE_SETS[tag], download_detour: 'proxy', update_interval: '3d' });
  }

  return {
    log: { level: s.logLevel, timestamp: true },
    dns,
    inbounds,
    outbounds,
    route: {
      rules,
      rule_set: ruleSet,
      final: onlyMode ? 'direct' : 'proxy',
      auto_detect_interface: true,
      default_domain_resolver: 'dns-direct',
    },
    experimental: {
      clash_api: { external_controller: `127.0.0.1:${API_PORT}`, secret },
      cache_file: { enabled: true, path: 'cache.db' },
    },
  };
}
