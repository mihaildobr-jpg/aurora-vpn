# Aurora VPN

Клиент VPN для Windows на ядре [sing-box](https://github.com/SagerNet/sing-box) и Tauri 2.

- Подписки (base64 / список ссылок / JSON sing-box): трафик, срок, автообновление
- VLESS (Reality, TLS; tcp/ws/grpc/h2/httpupgrade), VMess, Trojan, Shadowsocks, Hysteria2
- TUN (весь трафик системы) или системный прокси; локальный HTTP/SOCKS5 на 127.0.0.1:2080
- Россия напрямую: домены .ru/.рф/.su/…, geosite-category-ru, geoip-ru
- Приложения: «мимо VPN» или «только через VPN»
- Свои списки доменов/IP: напрямую / через VPN / блокировать
- Автовыбор самого быстрого сервера, TCP-пинг, график скорости, журнал, трей, автозапуск

## Сборка

**Через GitHub Actions (проще всего):** залейте папку в репозиторий на GitHub — workflow
`.github/workflows/build.yml` соберёт установщик `Aurora VPN_1.0.0_x64-setup.exe` (вкладка Actions → артефакт).
Тег `v1.0.0` дополнительно создаст релиз.

**Локально на Windows:** нужны [Rust](https://rustup.rs), Node.js и WebView2 (есть в Windows 10/11).

```powershell
./scripts/get-singbox.ps1
npm install
npx tauri build
```

Установщик появится в `src-tauri/target/release/bundle/nsis/`.

`npx tauri dev` запускает программу без запроса прав администратора — в этом режиме работает только
системный прокси. Для TUN запустите терминал от имени администратора.

## Устройство

| Файл | Что делает |
| --- | --- |
| `src/lib/parser.js` | разбор подписок и ссылок в outbound'ы sing-box |
| `src/lib/singbox.js` | сборка конфига: DNS, TUN, правила маршрутизации |
| `src/app.js` | интерфейс |
| `src-tauri/src/main.rs` | запуск/остановка ядра, загрузка подписки, пинг, трей, автозапуск |

Данные (`state.json`, `config.json`, кэш правил) лежат в `%APPDATA%\app.aurora.vpn`.

Тесты парсера и конфига: `npm test`. Посмотреть интерфейс в браузере без ядра: `npm run preview`.
