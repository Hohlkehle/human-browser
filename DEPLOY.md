# Browser MCP — Руководство по распространению и развёртыванию

Все доступные способы установки и запуска Browser MCP сервера.

## Требования

- **Node.js >= 22** (обязательно)
- **Google Chrome** с включённым удалённым отладчиком (`--remote-debugging-port=9222`)
- **npm** (входит в Node.js)

## Способы установки

| # | Способ | Где запускается | Сложность | Документация |
|---|--------|-----------------|-----------|--------------|
| 1 | **Локальная разработка** | Ваш компьютер (Windows/Mac/Linux) | Низкая | [deploy/local.md](deploy/local.md) |
| 2 | **Windows-служба** | Windows-машина (постоянно) | Средняя | [deploy/windows-service.md](deploy/windows-service.md) |
| 3 | **Docker** | Любой Linux/Docker-хост | Низкая | [deploy/docker.md](deploy/docker.md) |
| 4 | **Удалённый Linux-сервер** | VPS / dedicated (Ubuntu, Debian, CentOS) | Средняя | [deploy/remote-server.md](deploy/remote-server.md) |
| 5 | **Git-репозиторий** | Любой (клонирование + сборка) | Низкая | [deploy/repository.md](deploy/repository.md) |
| 6 | **npm-пакет** | Глобально через `npm install -g` | Низкая | [deploy/npm-publish.md](deploy/npm-publish.md) |
| 7 | **Cloud (AWS/GCP/Azure)** | Облачная VM | Высокая | [deploy/cloud-providers.md](deploy/cloud-providers.md) |
| 8 | **CI/CD Pipeline** | GitHub Actions / GitLab CI | Средняя | [deploy/ci-cd.md](deploy/ci-cd.md) |

## Быстрый старт (30 секунд)

```bash
git clone https://github.com/YOUR_USER/human-browser.git
cd human-browser
npm install
npm run build
set CDP_GATEWAY_TOKEN=ваш_секрет    # Windows
# export CDP_GATEWAY_TOKEN=ваш_секрет  # Linux/Mac
npm start
```

Сервер запустится на `http://127.0.0.1:9230/mcp`.

## Конфигурация

| Переменная | Описание | Значение по умолчанию |
|-----------|----------|----------------------|
| `CDP_ENDPOINT` | Адрес CDP-шлюза Chrome | `http://127.0.0.1:9222` |
| `CDP_GATEWAY_TOKEN` | Секретный токен (обязательно) | — |
| `GATEWAY_ENABLED` | Включить CDP-шлюз | `true` |
| `MCP_TRANSPORT` | Транспорт MCP | `streamable-http` |
| `MCP_LISTEN_HOST` | Адрес привязки MCP | `127.0.0.1` |
| `MCP_LISTEN_PORT` | Порт MCP | `9230` |
| `BROWSER_ALLOWED_DOMAINS` | Разрешённые домены | — |

Полный список: [.env.example](.env.example)

## Архитектура

```
Chrome (--remote-debugging-port=9222)
    │
    ▼
CDP Gateway (127.0.0.1:9229)  ← bearer token + CIDR allowlist
    │
    ▼
Browser Adapter (Playwright CDP)
    │
    ▼
MCP Server (127.0.0.1:9230)   ← Streamable HTTP или STDIO
    │
    ▼
AI Client (ChatGPT / Codex / другой MCP-клиент)
```

## Безопасность

- CDP Gateway требует bearer-токен на каждый запрос
- MCP-эндпоинт по умолчанию привязан к `127.0.0.1` (только loopback)
- Пароли никогда не заполняются и не читаются
- CAPTCHA всегда передаётся пользователю (никогда не автоматизируется)
- Секреты хранятся в переменных окружения, никогда в коде

## Поддержка

- Логи: `pino` структурированные JSON-логи с ротацией
- Здоровье: `GET /healthz` и `GET /readyz`
- Тесты: `npm test` (395+ тестов)
