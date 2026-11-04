// node --test tests/  — проверка парсера и генератора конфига (без настоящих ключей).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { parseLink, parseSubscription, parseUserinfo, parseTitle } from '../src/lib/parser.js';
import { buildConfig, defaultSettings } from '../src/lib/singbox.js';

const UUID = '11111111-2222-3333-4444-555555555555';
const REALITY = `vless://${UUID}@nl.example.net:443?type=tcp&security=reality&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&fp=chrome&sni=www.microsoft.com&sid=6ba85179e30d4fc2&flow=xtls-rprx-vision#%F0%9F%87%B3%F0%9F%87%B1%20Нидерланды`;
const WS = `vless://${UUID}@de.example.net:443?type=ws&security=tls&sni=de.example.net&path=%2Fws%3Fed%3D2048&host=cdn.example.net#🇩🇪 Germany WS`;
const GRPC = `vless://${UUID}@fi.example.net:443?type=grpc&security=reality&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&sni=www.google.com&serviceName=grpc#🇫🇮 Finland gRPC`;
const XHTTP = `vless://${UUID}@us.example.net:443?type=xhttp&security=reality&pbk=abc#🇺🇸 USA xhttp`;
const INFO = `vless://${UUID}@0.0.0.0:1?type=tcp#Осталось 30 дней`;
const SS = 'ss://' + Buffer.from('chacha20-ietf-poly1305:secret').toString('base64') + '@1.2.3.4:8388#SS';
const HY2 = 'hy2://pass@hy.example.net:8443?sni=hy.example.net&obfs=salamander&obfs-password=x#Hy2';
const TROJAN = 'trojan://pw@tr.example.net:443?sni=tr.example.net#Trojan';

test('vless reality', () => {
  const s = parseLink(REALITY);
  assert.equal(s.flag, 'nl');
  assert.equal(s.name, 'Нидерланды');
  assert.equal(s.outbound.flow, 'xtls-rprx-vision');
  assert.equal(s.outbound.tls.reality.short_id, '6ba85179e30d4fc2');
  assert.equal(s.outbound.tls.server_name, 'www.microsoft.com');
  assert.equal(s.outbound.tls.utls.fingerprint, 'chrome');
});

test('vless ws early data + grpc', () => {
  const ws = parseLink(WS).outbound;
  assert.equal(ws.transport.path, '/ws');
  assert.equal(ws.transport.max_early_data, 2048);
  assert.equal(ws.transport.headers.Host, 'cdn.example.net');
  assert.equal(ws.flow, undefined);
  assert.equal(parseLink(GRPC).outbound.transport.service_name, 'grpc');
});

test('subscription base64 + info nodes + unsupported', () => {
  const body = Buffer.from([REALITY, WS, GRPC, XHTTP, INFO, SS, HY2, TROJAN].join('\n')).toString('base64');
  const { servers, errors } = parseSubscription(body);
  assert.equal(errors.length, 0);
  assert.equal(servers.length, 8);
  assert.ok(servers.find((s) => s.network === 'xhttp').unsupported);
  assert.ok(servers.find((s) => s.port === 1).info);
  assert.equal(servers.find((s) => s.protocol === 'ss').outbound.method, 'chacha20-ietf-poly1305');
});

test('headers', () => {
  assert.deepEqual(parseUserinfo('upload=1; download=2; total=10; expire=1700000000'), { upload: 1, download: 2, total: 10, expire: 1700000000 });
  assert.equal(parseTitle('base64:' + Buffer.from('Quattro').toString('base64')), 'Quattro');
});

test('config variants', () => {
  const { servers } = parseSubscription([REALITY, WS, GRPC, XHTTP, INFO, SS, HY2, TROJAN].join('\n'));
  mkdirSync('tests/out', { recursive: true });
  const variants = {
    tun_rules: {},
    tun_bypass_apps: { appMode: 'bypass', apps: ['Telegram.exe', 'steam.exe'], ruGeoip: true, directList: 'example.org\n10.20.0.0/16\nkeyword:bank', proxyList: 'full:2ip.ru', blockList: 'ads.example.com' },
    tun_only_apps: { appMode: 'only', apps: ['chrome.exe'] },
    proxy_global: { mode: 'proxy', routing: 'global', dnsRemote: 'dns.google' },
  };
  for (const [name, patch] of Object.entries(variants)) {
    const cfg = buildConfig({ servers, selectedId: name === 'proxy_global' ? 'auto' : servers[0].id, settings: { ...defaultSettings, ...patch }, secret: 'test', selfExe: 'Aurora VPN.exe' });
    writeFileSync(`tests/out/${name}.json`, JSON.stringify(cfg, null, 2));
  }
  const only = buildConfig({ servers, selectedId: servers[0].id, settings: { ...defaultSettings, ...variants.tun_only_apps }, secret: 's' });
  assert.equal(only.route.final, 'direct');
  assert.equal(only.dns.final, 'dns-direct');
  const auto = buildConfig({ servers, selectedId: 'auto', settings: defaultSettings, secret: 's' });
  assert.equal(auto.outbounds[0].outbounds.length, 6); // без xhttp и info-узла
});
