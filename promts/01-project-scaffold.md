# Этап 1: каркас проекта

Цель: создать запускаемый TypeScript-проект с тестами и документацией.

Создай каркас Browser MCP.

Требования:

- Node.js 22+, TypeScript strict.
- Пакеты: `@modelcontextprotocol/sdk`, `playwright-core`, `zod`, `pino`.
- Vitest, ESLint и Prettier.
- Каталоги: `src/config`, `src/cdp`, `src/browser`, `src/mcp`, `src/policy`, `src/human`, `src/logging`, `tests/unit`, `tests/integration`, `docs`.
- Команды `dev`, `build`, `start`, `lint`, `typecheck`, `test`.
- Валидируемая через Zod конфигурация.
- Секреты только из переменных окружения.
- `.env.example` без настоящих секретов.
- Архитектура и threat model.

Критерии готовности: `npm run build`, `npm run lint`, `npm test`; сервер
запускается и корректно завершается по SIGINT/SIGTERM.
