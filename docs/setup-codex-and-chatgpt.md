# Установка и подключение Browser MCP: Codex CLI и ChatGPT

Пошаговая инструкция развертывания сервера Browser MCP и его использования как
MCP-сервера для Codex CLI и ChatGPT (десктоп-приложение и облачная версия).

```text
Chrome -> CDP (127.0.0.1:9222) -> [cdp-gateway 127.0.0.1:9229, опционально]
      -> Browser MCP (127.0.0.1:9230 или stdio) -> клиент (Codex / ChatGPT)
```

Три поддерживаемых сценария:

| Сценарий | Транспорт | Туннель | Раздел |
| ------- | --------- | ------- | ------ |
| Codex CLI | STDIO (сервер — дочерний процесс Codex) | не нужен | [4](#4-codex-cli-stdio) |
| ChatGPT desktop, developer mode | Streamable HTTP, только loopback | не нужен | [5](#5-chatgpt-desktop-developer-mode-без-туннеля) |
| Облачный ChatGPT (chatgpt.com) | Streamable HTTP через Cloudflare Tunnel | нужен | [6](#6-облачный-chatgpt-через-туннель) |

## 1. Предварительные требования

- Node.js **22+** (проверка: `node -v`)
- Google Chrome (только видимый режим; headless сервером отклоняется)
- Codex CLI — для сценария 4
- ChatGPT desktop — для сценария 5
- Аккаунт Cloudflare Zero Trust + `cloudflared` — для сценария 6

## 2. Сборка сервера

В каталоге репозитория (например, `E:\souce\human-browser`):

```powershell
npm install
npm run build
```

Результат сборки — `dist/src/main.js`. Проверка (рекомендуется):

```powershell
npm test                          # 395 тестов
node scripts/verify-mvp-smoke.mjs # живой smoke-тест собранного сервера
```

## 3. Запуск Chrome с включенным CDP

Сервер управляет уже запущенным видимым Chrome через CDP на
`http://127.0.0.1:9222`. Запустите Chrome с флагом remote debugging и
**отдельным каталогом профиля** (Chrome отключает debugging для профиля по
умолчанию):

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="C:\chrome-mcp-profile" `
  --no-first-run --no-default-browser-check about:blank
```

Чтобы сохранить существующие сессии сайтов (например, логин на partslink24),
укажите в `--user-data-dir` постоянный каталог и один раз залогиньтесь в нем
вручную — сессия переживает перезапуски сервера.

Проверка:

```powershell
curl.exe http://127.0.0.1:9222/json/version
```

Ожидается JSON с полем `Protocol-Version`.

## 4. Codex CLI (STDIO)

В STDIO-режиме Codex сам запускает сервер как дочерний процесс: stdout —
MCP JSON-RPC, логи — stderr, HTTP-слушателя нет. Токены и туннель не нужны.

Добавьте в `~/.codex/config.toml`
(Windows: `C:\Users\<имя>\.codex\config.toml`):

```toml
[mcp_servers.browser]
command = "node"
args = ["E:/souce/human-browser/dist/src/main.js"]

[mcp_servers.browser.env]
MCP_TRANSPORT = "stdio"
# Простейшая локальная цепочка: адаптер -> Chrome CDP напрямую.
# Гейтвей для STDIO опционален.
GATEWAY_ENABLED = "false"
CDP_ENDPOINT = "http://127.0.0.1:9222"
BROWSER_ALLOWED_DOMAINS = "partslink24.com,www.partslink24.com,partsouq.com,www.partsouq.com"
```

Вариант с включенным гейтвеем (дополнительная защита, сервер 9229 должен быть
запущен через `npm start`):

```toml
# GATEWAY_ENABLED = "true"
# CDP_ENDPOINT = "http://127.0.0.1:9229"
# CDP_GATEWAY_TOKEN = "<длинный случайный секрет>"
```

Проверка:

```powershell
codex
```

Попросите Codex вызвать `browser_status`, затем `browser_connect`:

- `browser_status` → `connected: false`, `humanControl.state = "ready"`,
  доступны 15 инструментов;
- после `browser_connect` → `connected: true`.

Для разработки вместо сборки можно использовать tsx:
`command = "npx"`, `args = ["tsx", "src/main.ts"]`.

Подробнее: [`local-clients.md`](local-clients.md).

## 5. ChatGPT desktop, developer mode (без туннеля)

Десктоп-приложение подключается к локальным **HTTP** MCP-серверам, поэтому
сервер запускается в режиме Streamable HTTP (по умолчанию), слушая только
`127.0.0.1:9230`.

1. Запустите сервер (Chrome из шага 3 уже должен работать):

   ```powershell
   $env:CDP_GATEWAY_TOKEN = "<длинный случайный секрет>"  # если GATEWAY_ENABLED=true
   npm start          # обслуживает http://127.0.0.1:9230/mcp
   ```

   Либо без гейтвея: `$env:GATEWAY_ENABLED = "false"` перед `npm start`.

2. Проверьте эндпоинт:

   ```powershell
   curl.exe http://127.0.0.1:9230/healthz   # {"status":"ok"}
   ```

3. В приложении ChatGPT: **Settings → Developer → Developer mode** (включить).

4. В чате: **+ → Connect to a local/developer MCP server**, укажите
   `http://127.0.0.1:9230/mcp`.

5. Приложение покажет 15 инструментов; первый тест — вызов `browser_status`.

## 6. Облачный ChatGPT через туннель

Доступ chatgpt.com без публикации портов: `cloudflared` устанавливает
**исходящее** соединение к Cloudflare edge, которое пробрасывается на локальный
loopback MCP-эндпоинт. Туннелируется **только** MCP (9230) — никогда сырой CDP
(9222) или гейтвей (9229).

### 6.1. Установка cloudflared

```powershell
winget install --id Cloudflare.cloudflared
cloudflared --version
```

Требуется cloudflared 2023.8+. Альтернатива: скачать `cloudflared.exe` и задать
`$env:TUNNEL_CLOUDFLARED_BIN = "C:\tools\cloudflared.exe"`.

### 6.2. Создание именованного туннеля (рекомендуется)

1. Cloudflare Zero Trust dashboard: **Networks → Tunnels → Create a tunnel** →
   тип коннектора **Cloudflared** → скопируйте **токен туннеля**.
   (Команда "install connector" из дашборда не нужна — cloudflared запускает
   сам проект.)
2. Добавьте публичный hostname, например `browser-mcp.example.com`, сервис
   `http://127.0.0.1:9230`.

Быстрый туннель только для тестов: `TUNNEL_MODE=quick` — временный
неаутентифицированный URL `*.trycloudflare.com`, меняется при каждом запуске.

### 6.3. Секрет (только через окружение)

```powershell
# только для текущей сессии:
$env:CLOUDFLARE_TUNNEL_TOKEN = "<токен из дашборда>"

# либо сохранить для пользователя (вне репозитория):
[Environment]::SetEnvironmentVariable("CLOUDFLARE_TUNNEL_TOKEN", "<токен>", "User")
```

Никогда не записывайте токен в `.env`, конфиги или git.

### 6.4. Запуск и проверка цепочки

```powershell
# терминал 1 — сервер MCP (HTTP-режим, по умолчанию):
$env:CDP_GATEWAY_TOKEN = "<секрет>"   # если GATEWAY_ENABLED=true
npm start

# терминал 2 — проверка всей локальной цепочки:
npm run tunnel:doctor

# проверка публичного хопа (то же соединение, что делает ChatGPT):
$env:TUNNEL_PUBLIC_URL = "https://browser-mcp.example.com"
npm run tunnel:doctor

# запуск туннеля (Ctrl+C — корректная остановка):
npm run tunnel:run
```

`doctor` проверяет: Node >= 22, конфиг туннеля, cloudflared, токен,
`/healthz`, `/readyz` и полный MCP-обмен (`initialize` + `tools/list` +
`browser_status`). Код 0 — цепочка исправна.

### 6.5. Подключение ChatGPT (custom connector)

1. chatgpt.com → **Settings → Apps & Connectors** (или **Connectors**) →
   **Advanced settings → Create custom connector**.
2. URL: `https://browser-mcp.example.com/mcp` (ваш публичный hostname + `/mcp`).
3. Сохраните; в чате: **+ → Connectors** → включите ваш коннектор. ChatGPT
   выполнит `initialize` + `tools/list` и покажет 15 инструментов
   `browser_*`/`page_*`/`human_*`.
4. Первый тест — попросите вызвать `browser_status`.

Названия меню могут отличаться в разных версиях ChatGPT; ключевой ввод —
Streamable HTTP URL `https://<публичный-hostname>/mcp`.

Подробности и диагностика по хопам: [`tunnel-client.md`](tunnel-client.md).

## 7. Диагностика (по хопам)

Каждый шаг должен пройти, прежде чем переходить к следующему:

| # | Хоп | Проверка | Ожидается |
| - | --- | -------- | --------- |
| 1 | Chrome + CDP | `curl.exe http://127.0.0.1:9222/json/version` | JSON с `Protocol-Version` |
| 2 | CDP gateway (если включен) | `curl.exe http://127.0.0.1:9229/healthz` | `{"status":"ok"}`; без токена `/json/version` → **401** |
| 3 | Browser MCP | `curl.exe http://127.0.0.1:9230/healthz` и `/readyz` | `{"status":"ok"}` |
| 3b | MCP-протокол | `npx @modelcontextprotocol/inspector` → Streamable HTTP `http://127.0.0.1:9230/mcp` → Tools → `browser_status` | 15 инструментов |
| 4 | Туннель | `npm run tunnel:doctor` | все `[ ok ]`; в логе `tunnel:run` — `Registered tunnel connection` |
| 5 | Публичный хоп | `$env:TUNNEL_PUBLIC_URL="https://<host>"; npm run tunnel:doctor` | `public-hop [ ok ]` |
| 6 | Клиент | Codex / ChatGPT вызывает `browser_status` | ответ инструмента |

Типичные сбои:

- **502 из туннеля** — туннель поднят, но сервер MCP не запущен: `npm start`.
- **`cloudflared` не найден** — установите или задайте `TUNNEL_CLOUDFLARED_BIN`.
- **Именованный туннель не стартует** — нет `CLOUDFLARE_TUNNEL_TOKEN` в
  окружении терминала с `tunnel:run`.
- **ChatGPT не видит инструменты** — сначала проверьте хоп 5; затем что URL
  коннектора заканчивается на `/mcp`.
- **`npm start` отказывается стартовать** — при `GATEWAY_ENABLED=true`
  обязателен `CDP_GATEWAY_TOKEN` в окружении.

### Важно: файл `.env` НЕ загружается автоматически

Сервер читает конфигурацию **только из переменных окружения процесса**
(`src/config/schema.ts` → `process.env`); зависимости dotenv нет, и скрипт
`start` — это просто `node dist/src/main.js`. Файл `.env` в корне репозитория
никогда не подхватывается сам по себе. Если токен указан в `.env`, но
`npm start` падает с `Gateway refuses to start without secret
CDP_GATEWAY_TOKEN` — переменная не попала в процесс. Способы inject'а:

```powershell
# 1. Задать в текущем терминале (рекомендуется):
$env:CDP_GATEWAY_TOKEN = "<секрет>"
npm start

# 2. Загрузить весь .env средствами Node 22+:
node --env-file=.env dist/src/main.js

# 3. Для Codex CLI (STDIO) — env-таблица в ~/.codex/config.toml
#    ([mcp_servers.browser.env]); Codex передаст их дочернему процессу.
```

Для продакшена (служба Windows, Stage 8) секреты хранятся в Credential Manager
служебной учетной записи — см. [`windows-deployment.md`](windows-deployment.md).

## 8. Замечания по безопасности

- Все секреты (`CDP_GATEWAY_TOKEN`, `CLOUDFLARE_TUNNEL_TOKEN`) — только через
  переменные окружения или защищенное хранилище ОС; никогда в файлах
  конфигурации и git.
- MCP-эндпоинт не имеет собственной аутентификации: публичный hostname туннеля
  фактически является его паролем. Держите его на своем домене, не
  распространяйте и останавливайте туннель (Ctrl+C) по окончании работы.
- Сырой CDP (9222) никогда не публикуется и не туннелируется.
- `BROWSER_ALLOWED_DOMAINS` ограничивает допустимые сайты для
  `page_open`/`page_navigate`. Записи — точные имена (`example.com`, без
  поддоменов) или wildcard `*.example.com` (только поддомены). Одиночная
  запись `*` явно разрешает ЛЮБЫЕ http/https-сайты (сервер логирует
  предупреждение при старте) — удобно для локального использования с Codex:
  `BROWSER_ALLOWED_DOMAINS = "*"` в env-таблице config.toml. Для доступа
  через туннель (облачный ChatGPT) рекомендуется оставить явный список.
- CAPTCHA и логины никогда не автоматизируются: сервер ставит паузу
  (`human_required`), поднимает вкладку в Chrome — действие выполняете вы
  вручную, затем агент вызывает `human_resume`.
- Парольные поля недоступны для заполнения; чувствительные значения
  маскируются в снапшотах, логах и результатах извлечения.

## Связанные документы

- [`local-clients.md`](local-clients.md) — STDIO-клиенты и MCP Inspector
- [`tunnel-client.md`](tunnel-client.md) — туннель, режимы, диагностика
- [`windows-deployment.md`](windows-deployment.md) — установка как службу
  Windows (Stage 8)
- [`windows-firewall.md`](windows-firewall.md) — правила брандмауэра для
  LAN-доступа
