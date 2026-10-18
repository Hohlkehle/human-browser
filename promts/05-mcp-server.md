# Этап 5: MCP-сервер и схемы инструментов

Цель: предоставить браузерные операции как строго типизированные MCP tools.

Поддержи STDIO и Streamable HTTP. Все input/output schemas опиши через Zod и
JSON Schema. Добавь server instructions с правилами безопасности и side-effect
annotations для каждого инструмента.

Инструменты:

`browser_connect`, `browser_status`, `page_list`, `page_open`, `page_navigate`,
`page_snapshot`, `page_screenshot`, `page_click`, `page_fill`, `page_select`,
`page_press`, `page_wait`, `page_extract`, `human_required`, `human_resume`.

Возвращай структурированные ошибки, не возвращай cookies, headers,
localStorage или credentials. Запрети `page_fill` для
`input[type=password]`, а `page_navigate` ограничь доменным allowlist.

Критерии: MCP Inspector видит все tools; аргументы валидируются до браузера;
запрещённые домены и password-поля блокируются.
