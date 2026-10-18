# CI/CD — Автоматическая сборка и публикация

## GitHub Actions

### 1. Тестирование при каждом PR

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [22, 23]

    steps:
      - uses: actions/checkout@v4

      - name: Use Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Type check
        run: npm run typecheck

      - name: Build
        run: npm run build

      - name: Test
        run: npm test
```

### 2. Публикация при релизе

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write
  packages: write
  id-token: write

jobs:
  build-and-publish:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Test
        run: npm test

      - name: Publish to npm
        run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
          files: |
            dist/**/*.js
            dist/**/*.d.ts
```

### 3. Docker-сборка и публикация

```yaml
# .github/workflows/docker.yml
name: Docker

on:
  push:
    branches: [main]
    tags: ["v*"]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      - name: Log in to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha

      - name: Build and push Docker image
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

### 4. Полный CI/CD pipeline

```yaml
# .github/workflows/pipeline.yml
name: Full Pipeline

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  # Этап 1: Качество кода
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck

  # Этап 2: Тесты
  test:
    runs-on: ubuntu-latest
    needs: quality
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm test

  # Этап 3: Сборка Docker
  docker:
    runs-on: ubuntu-latest
    needs: test
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ghcr.io/${{ github.repository }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

  # Этап 4: Публикация npm (только по тегу)
  publish:
    runs-on: ubuntu-latest
    needs: test
    if: startsWith(github.ref, 'refs/tags/v')
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## GitLab CI

### .gitlab-ci.yml

```yaml
stages:
  - quality
  - test
  - build
  - deploy

variables:
  NODE_VERSION: "22"

cache:
  key: ${CI_COMMIT_REF_SLUG}
  paths:
    - node_modules/

lint:
  stage: quality
  image: node:${NODE_VERSION}
  script:
    - npm ci
    - npm run lint

typecheck:
  stage: quality
  image: node:${NODE_VERSION}
  script:
    - npm ci
    - npm run typecheck

test:
  stage: test
  image: node:${NODE_VERSION}
  script:
    - npm ci
    - npm run build
    - npm test

build:
  stage: build
  image: node:${NODE_VERSION}
  script:
    - npm ci
    - npm run build
  artifacts:
    paths:
      - dist/
    expire_in: 1 week

docker:
  stage: build
  image: docker:latest
  services:
    - docker:dind
  only:
    - main
  script:
    - docker build -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA .
    - docker push $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA

npm-publish:
  stage: deploy
  image: node:${NODE_VERSION}
  only:
    - tags
  script:
    - npm ci
    - npm run build
    - echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > .npmrc
    - npm publish --access public
```

## Jenkins

### Jenkinsfile

```groovy
pipeline {
    agent any

    environment {
        NODEJS_HOME = tool 'Node-22'
        NPM_TOKEN = credentials('npm-token')
    }

    stages {
        stage('Install') {
            steps {
                sh 'npm ci'
            }
        }

        stage('Lint') {
            steps {
                sh 'npm run lint'
            }
        }

        stage('Type Check') {
            steps {
                sh 'npm run typecheck'
            }
        }

        stage('Build') {
            steps {
                sh 'npm run build'
            }
        }

        stage('Test') {
            steps {
                sh 'npm test'
            }
        }

        stage('Publish') {
            when {
                branch 'main'
            }
            steps {
                sh '''
                    echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc
                    npm publish --access public
                '''
            }
        }
    }

    post {
        always {
            cleanWs()
        }
    }
}
```

## Настройка секретов

### GitHub Secrets

| Секрет | Описание |
|--------|----------|
| `NPM_TOKEN` | Токен npm для публикации |
| `DOCKER_USERNAME` | Docker Hub username (если используется) |
| `DOCKER_PASSWORD` | Docker Hub password |
| `SLACK_WEBHOOK` | Webhook для уведомлений в Slack |

### GitLab CI/CD Variables

| Переменная | Описание |
|------------|----------|
| `NPM_TOKEN` | Токен npm |
| `CI_REGISTRY_USER` | Docker registry username |
| `CI_REGISTRY_PASSWORD` | Docker registry password |

### Jenkins Credentials

| ID | Тип | Описание |
|----|-----|----------|
| `npm-token` | Secret text | Токен npm |
| `docker-hub` | Username/Password | Docker Hub |

## Уведомления

### Slack

```yaml
# GitHub Actions
- name: Notify Slack
  uses: slackapi/slack-github-action@v1
  with:
    payload: |
      {
        "text": "Build ${{ job.status }}: ${{ github.repository }}@${{ github.ref_name }}"
      }
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK }}
```

### Email (GitLab)

```yaml
email:
  stage: deploy
  script:
    - echo "New version published: $CI_COMMIT_TAG"
  after_script:
    - echo "Sending email notification..."
```

## Чеклист перед публикацией

- [ ] Все тесты проходят (`npm test`)
- [ ] Lint без ошибок (`npm run lint`)
- [ ] Type check без ошибок (`npm run typecheck`)
- [ ] Версия обновлена (`npm version patch/minor/major`)
- [ ] CHANGELOG обновлён
- [ ] README обновлён
- [ ] Тег создан (`git tag v0.1.0`)
- [ ] Тег запушен (`git push --follow-tags`)
