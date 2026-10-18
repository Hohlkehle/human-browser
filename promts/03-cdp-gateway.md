# Этап 3: защищённый CDP gateway

Цель: реализовать авторизованный прокси CDP.

Он слушает `0.0.0.0:9229` и проксирует HTTP/WebSocket на
`127.0.0.1:9222`.

Требования:

- Использовать `http-proxy`.
- Разрешить только `/json/version`, `/json/list`, `/json/new`, `/devtools/*`.
- Bearer-аутентификация для HTTP и WebSocket upgrade.
- CIDR allowlist и rate limiting.
- Ограничить размер заголовков и тела.
- Запрещать запуск без токена или `allowedCidrs`.
- Не логировать query strings, Authorization и CDP frames.
- Отдельные health endpoints без данных Chrome.
- Корректно закрывать WebSocket при остановке.
- Документировать Windows Firewall с ограничением подсети и запрет публикации в интернет.

Проверить 401 для HTTP, отказ неавторизованного WebSocket, 403 для внешнего
IP, Playwright с Authorization header и интеграционные тесты с тестовым upstream.
