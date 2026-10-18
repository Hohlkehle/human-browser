# Этап 7: Secure MCP Tunnel

Цель: дать облачному ChatGPT доступ без публикации CDP или MCP-порта.

MCP HTTP слушает только `127.0.0.1`. Добавь `healthz`, `readyz`, документацию
`tunnel-client` для Windows, команды `doctor` и `run`. API key не хранится в
config или репозитории. Опиши подключение developer-mode app в ChatGPT и
диагностику `Chrome -> CDP -> Browser MCP -> tunnel-client -> ChatGPT`.

Не используй публичный raw-CDP endpoint. Добавь локальный STDIO-сценарий для
Codex CLI/Desktop без tunnel.

Критерии: Inspector вызывает browser_status, `tunnel-client doctor` проходит,
ChatGPT видит tools через тестовое подключение.
