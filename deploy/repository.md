# Установка из Git-репозитория

## Из официального репозитория

### Клонирование

```bash
# HTTPS
git clone https://github.com/YOUR_USER/human-browser.git

# SSH
git clone git@github.com:YOUR_USER/human-browser.git

# Определённая версия
git clone --branch v0.1.0 https://github.com/YOUR_USER/human-browser.git
```

### Сборка и запуск

```bash
cd human-browser
npm install
npm run build
npm test

# Запуск
set CDP_GATEWAY_TOKEN=секрет    # Windows
# export CDP_GATEWAY_TOKEN=секрет  # Linux/Mac
npm start
```

## Из форка

### 1. Форк через GitHub UI

1. Откройте https://github.com/YOUR_USER/human-browser
2. Нажмите "Fork" в правом верхнем углу
3. Выберите целевую организацию/аккаунт

### 2. Клонирование форка

```bash
# Клонируйте ваш форк
git clone https://github.com/YOUR_USERNAME/human-browser.git
cd human-browser

# Добавьте upstream (опционально, для синхронизации)
git remote add upstream https://github.com/YOUR_USER/human-browser.git

# Проверьте remote
git remote -v
# origin    https://github.com/YOUR_USERNAME/human-browser.git (fetch)
# origin    https://github.com/YOUR_USERNAME/human-browser.git (push)
# upstream  https://github.com/YOUR_USER/human-browser.git (fetch)
# upstream  https://github.com/YOUR_USER/human-browser.git (push)
```

### 3. Синхронизация с upstream

```bash
# Получите последние изменения из оригинала
git fetch upstream

# Слейте в свою ветку
git checkout main
git merge upstream/main

# Отправьте в свой форк
git push origin main
```

## Из приватного репозитория

### GitHub Private

```bash
# Клонирование с токеном
git clone https://YOUR_TOKEN@github.com/YOUR_ORG/human-browser.git

# Или через SSH (настроенный ключ)
git clone git@github.com:YOUR_ORG/human-browser.git
```

### GitLab Private

```bash
# С персональным токеном
git clone https://oauth2:YOUR_TOKEN@gitlab.com/YOUR_ORG/human-browser.git

# Или с deploy token
git clone https://deploy-token-name:deploy-token-password@gitlab.com/YOUR_ORG/human-browser.git
```

### Self-hosted Git (Gitea, Gogs, Bitbucket)

```bash
# Gitea
git clone https://gitea.yourcompany.com/YOUR_ORG/human-browser.git

# С токеном
git clone https://YOUR_TOKEN@gitea.yourcompany.com/YOUR_ORG/human-browser.git
```

## Установка как npm-пакет из Git

### Из GitHub

```bash
# Из main ветки
npm install github:YOUR_USER/human-browser

# Из определённого тега
npm install github:YOUR_USER/human-browser#v0.1.0

# Из определённого коммита
npm install github:YOUR_USER/human-browser#abc1234

# Из форка
npm install github:YOUR_USERNAME/human-browser
```

### Из GitLab

```bash
npm install git+https://oauth2:TOKEN@gitlab.com/YOUR_ORG/human-browser.git
```

### Из приватного репозитория

```bash
# Через .npmrc
echo "//npm.pkg.github.com/:_authToken=YOUR_TOKEN" >> ~/.npmrc
npm install @YOUR_ORG/human-browser
```

## Установка по тегу/релизу

```bash
# Все теги
git tag -l

# Клонирование конкретного тега
git clone --branch v0.1.0 https://github.com/YOUR_USER/human-browser.git

# Установка npm из тега
npm install github:YOUR_USER/human-browser#v0.1.0
```

## Из архива (без Git)

### Скачивание ZIP

```bash
# Через GitHub API
curl -L https://github.com/YOUR_USER/human-browser/archive/refs/heads/main.zip -o browser-mcp.zip

# Или просто
# Нажмите "Code" → "Download ZIP" на странице репозитория

# Распаковка
unzip browser-mcp.zip
cd human-browser-main

# Сборка
npm install
npm run build
npm start
```

## Версионирование

```bash
# Посмотреть текущую версию
cat package.json | grep version

# Все доступные теги
git tag -l

# Переключиться на версию
git checkout v0.1.0

# Создать новый тег
git tag -a v0.2.0 -m "Release 0.2.0"
git push origin v0.2.0
```

## Установка в CI/CD

### GitHub Actions

```yaml
- name: Install Browser MCP
  run: |
    npm install github:YOUR_USER/human-browser#main
    # Или конкретная версия:
    # npm install github:YOUR_USER/human-browser#v0.1.0
```

### GitLab CI

```yaml
install-browser-mcp:
  script:
    - npm install git+https://oauth2:${CI_JOB_TOKEN}@gitlab.com/YOUR_ORG/human-browser.git
```

## Обновление

```bash
cd human-browser

# Получить последние изменения
git pull origin main

# Переустановить зависимости (если изменились)
npm install

# Пересобрать
npm run build

# Перезапустить
npm start
```

## Частые проблемы

| Проблема | Решение |
|----------|---------|
| `Permission denied (publickey)` | Настройте SSH-ключ: `ssh-keygen -t ed25519` |
| `npm ERR! code ENOGIT` | Установите Git: `apt install git` |
| `npm ERR! node_modules exists` | Удалите `node_modules` и повторите `npm install` |
| `Cannot find module` | Убедитесь, что выполнили `npm run build` |
| Git clone очень медленный | Используйте shallow clone: `git clone --depth 1 URL` |
