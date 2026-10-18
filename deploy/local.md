# Локальная установка и запуск

## Предварительные требования

1. **Node.js 22+** — проверьте: `node --version`
2. **Google Chrome** — установлен и доступен
3. **Git** — для клонирования репозитория

## Установка

```bash
# 1. Клонируйте репозиторий
git clone https://github.com/YOUR_USER/human-browser.git
cd human-browser

# 2. Установите зависимости
npm install

# 3. Соберите проект
npm run build

# 4. Проверьте работоспособность
npm test
```

## Запуск Chrome с CDP

Chrome необходимо запустить с флагом удалённой отладки:

### Windows

```powershell
# Закройте все экземпляры Chrome, затем:
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\temp\chrome-debug"
```

### macOS

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

### Linux

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

> **Важно:** Закройте все существующие экземпляры Chrome перед запуском с `--remote-debugging-port`.

## Запуск сервера

### Вариант 1: С gateway (рекомендуется)

```bash
# Windows (PowerShell)
$env:CDP_GATEWAY_TOKEN = "ваш_длинный_случайный_секрет"
npm start

# Windows (cmd)
set CDP_GATEWAY_TOKEN=ваш_длинный_случайный_секрет
npm start

# Linux / macOS
export CDP_GATEWAY_TOKEN="ваш_длинный_случайный_секрет"
npm start
```

### Вариант 2: Без gateway (прямое подключение к Chrome)

```bash
$env:GATEWAY_ENABLED = "false"    # Windows
# export GATEWAY_ENABLED=false    # Linux/Mac
npm start
```

### Вариант 3: STDIO-режим (для локальных MCP-клиентов)

```bash
$env:MCP_TRANSPORT = "stdio"
npm start
```

### Вариант 4: Режим разработки (hot reload)

```bash
npm run dev
```

## Использование .env файла

Скопируйте шаблон конфигурации:

```bash
cp .env.example .env
# Windows:
copy .env.example .env
```

Отредактируйте `.env` и задайте `CDP_GATEWAY_TOKEN`:

```env
CDP_GATEWAY_TOKEN=ваш_секрет_здесь
GATEWAY_ENABLED=true
MCP_LISTEN_HOST=127.0.0.1
MCP_LISTEN_PORT=9230
```

## Проверка работоспособности

```bash
# 1. Запустите сервер
npm start

# 2. В другом терминале проверьте healthcheck
curl http://127.0.0.1:9230/healthz
# Ответ: {"status":"ok"}

# 3. Запустите полный smoke-тест
node scripts/verify-mvp-smoke.mjs
```

## Подключение AI-клиента

### ChatGPT Desktop (developer mode)

1. Откройте ChatGPT Desktop → Settings → Developer → MCP Servers
2. Добавьте сервер:
   - Name: `browser-mcp`
   - Transport: `HTTP`
   - URL: `http://127.0.0.1:9230/mcp`

### Codex CLI (STDIO)

```bash
# В конфигурации Codex CLI:
{
  "mcpServers": {
    "browser-mcp": {
      "command": "node",
      "args": ["dist/src/main.js"],
      "cwd": "/path/to/human-browser",
      "env": {
        "MCP_TRANSPORT": "stdio",
        "CDP_GATEWAY_TOKEN": "ваш_секрет",
        "GATEWAY_ENABLED": "false"
      }
    }
  }
}
```

## Cloudflare Tunnel (для облачного доступа)

```bash
# 1. Установите cloudflared
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# 2. Проверьте цепочку
npm run tunnel:doctor

# 3. Запустите туннель (быстрый режим, для тестирования)
npm run tunnel:run

# Или с именем (для постоянного доступа)
# Установите CLOUDFLARE_TUNNEL_TOKEN в переменных окружения
npm run tunnel:run
```

## Устранение неполадок

| Проблема | Решение |
|----------|---------|
| `CDP_GATEWAY_TOKEN not set` | Задайте переменную окружения перед `npm start` |
| `EADDRINUSE :9229` | Другой процесс использует порт. Используйте другой порт через `GATEWAY_LISTEN_PORT` |
| `ECONNREFUSED 127.0.0.1:9222` | Chrome не запущен с `--remote-debugging-port=9222` |
| `connect ECONNREFUSED` | Убедитесь, что Chrome и сервер работают |
| `visible mode required` | Запускайте Chrome в обычном (не headless) режиме |
