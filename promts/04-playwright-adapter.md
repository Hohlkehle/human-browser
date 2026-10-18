# Этап 4: адаптер Playwright/CDP

Цель: управлять существующим видимым профилем Chrome без получения секретов.

Реализуй `BrowserAdapter` на `playwright-core.connectOverCDP`.

Требования:

- HTTP или WebSocket CDP endpoint с дополнительными Authorization headers.
- `disconnect` не закрывает пользовательский Chrome.
- Стабильные внутренние `pageId` и `contextId`.
- Операции list/open/navigate/snapshot/screenshot/click/fill/select/press/wait/extract.
- Локаторы role, label, text и CSS.
- Без внешнего произвольного evaluate.
- Лимиты вкладок и параллельных операций.
- Таймаут операции и AbortSignal.
- Обработка закрытия вкладки и перезапуска Chrome.
- Редакция чувствительных полей в snapshot и логах.

Добавь интеграционные тесты с тестовым Chrome. Проверь, что disconnect не
останавливает Chrome.
