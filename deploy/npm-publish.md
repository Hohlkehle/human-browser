# Публикация в npm и установка через npm

## Подготовка к публикации

### 1. Настройка package.json

Убедитесь, что `package.json` готов к публикации:

```json
{
  "name": "@your-org/browser-mcp",
  "version": "0.1.0",
  "description": "Security-first MCP browser control for a visible Chrome session.",
  "main": "dist/src/main.js",
  "bin": {
    "browser-mcp": "dist/src/main.js"
  },
  "files": [
    "dist/",
    "README.md",
    "LICENSE"
  ],
  "keywords": [
    "mcp",
    "browser",
    "chrome",
    "cdp",
    "ai",
    "chatgpt",
    "playwright"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/YOUR_USER/human-browser.git"
  },
  "license": "MIT",
  "engines": {
    "node": ">=22"
  }
}
```

### 2. Создайте .npmignore

```
src/
tests/
docs/
promts/
scripts/
.env
.env.example
tsconfig.json
eslint.config.mjs
.prettierrc
.git/
.github/
*.log
```

### 3. Создайте LICENSE

```
MIT License

Copyright (c) 2026 Browser MCP Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Публикация

### В npmjs.com (публичный)

```bash
# 1. Войдите в npm
npm login

# 2. Убедитесь, что залогинены
npm whoami

# 3. Соберите проект
npm run build

# 4. Проверьте, что будет опубликовано
npm pack --dry-run

# 5. Опубликуйте
npm publish

# Для scoped пакета (--access public)
npm publish --access public
```

### В GitHub Packages

```bash
# 1. Настройте .npmrc
echo "@YOUR_ORG:registry=https://npm.pkg.github.com" > .npmrc
echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> .npmrc

# 2. Войдите
npm login --registry=https://npm.pkg.github.com

# 3. Опубликуйте
npm publish
```

### В приватный реестр (Verdaccio, Nexus, Artifactory)

```bash
# 1. Настройте реестр
npm config set registry http://verdaccio.yourcompany.com:4873

# 2. Войдите
npm login

# 3. Опубликуйте
npm publish
```

### В Forestry JSR (для ESM-пакетов)

```bash
# Инициализация
npx jsr init

# Публикация
npx jsr publish
```

## Версионирование

```bash
# Патч-версия (0.1.0 → 0.1.1)
npm version patch

# Минорная версия (0.1.0 → 0.2.0)
npm version minor

# Мажорная версия (0.1.0 → 1.0.0)
npm version major

# Автоматический пуш тега
npm version patch --git-tag-version
git push --follow-tags
```

## Установка пользователями

### Из npmjs.com

```bash
# Глобально
npm install -g @your-org/browser-mcp

# В проект
npm install @your-org/browser-mcp

# Определённая версия
npm install @your-org/browser-mcp@0.1.0
```

### Из GitHub Packages

```bash
# Настройка .npmrc в проекте
echo "@YOUR_ORG:registry=https://npm.pkg.github.com" > .npmrc
echo "//npm.pkg.github.com/:_authToken=YOUR_TOKEN" >> .npmrc

# Установка
npm install @YOUR_ORG/browser-mcp
```

### Из приватного реестра

```bash
npm config set registry http://verdaccio.yourcompany.com:4873
npm install @your-org/browser-mcp
```

## CLI-команда

После глобальной установки доступна команда `browser-mcp`:

```bash
# Запуск
browser-mcp

# С аргументами
browser-mcp --port 9230 --transport streamable-http

# С переменными окружения
CDP_GATEWAY_TOKEN=secret browser-mcp
```

## Автоматическая публикация через CI

### GitHub Actions

```yaml
# .github/workflows/publish.yml
name: Publish to npm

on:
  release:
    types: [created]

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### GitLab CI

```yaml
publish:
  stage: deploy
  only:
    - tags
  script:
    - npm ci
    - npm run build
    - npm test
    - echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > .npmrc
    - npm publish --access public
```

## Проверка публикации

```bash
# Проверьте на npmjs.com
npm view @your-org/browser-mcp

# Проверьте версию
npm view @your-org/browser-mcp version

# Проверьте теги
npm view @your-org/browser-mcp dist-tags

# Проверьте содержимое
npm pack --dry-run
```

## Удаление публикации

```bash
# Удалить конкретную версию
npm unpublish @your-org/browser-mcp@0.1.0

# Удалить весь пакет (осторожно!)
npm unpublish @your-org/browser-mcp --force
```

> **Внимание:** npm не разрешает повторно опубликовать версию в течение 72 часов после удаления.
