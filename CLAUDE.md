# Instructions for Claude

## First steps

**Always read `README.md` first** — it contains the up-to-date project overview, architecture, structure, and conventions. Orient yourself there before diving into specific files.

## Sample bank-statement files

Никогда не создавай и не коммить сам реальные банковские выгрузки в `samples/`. Эти файлы кладёт пользователь — они могут содержать персональные данные (имена, номера счетов, контрагенты), и их обфускация/выкладка — задача пользователя.

Структура папки: `samples/<preset-id>/<format-id>/<filename>` (например, `samples/kasikorn/kasikorn-csv-v1/statement-2025-05.csv`).

При разработке парсеров под конкретный формат тестовые фикстуры держи **inline в коде теста** (синтетический CSV-литерал), а не привязывай тесты к файлам в `samples/` — иначе тесты сломаются у того, у кого этих файлов нет.

## Стенды

На DevBox работают только **DEV**-стенды — не UAT. Так их и называем везде: контейнеры, папки данных, документация, сообщения пользователю.

DEV-стенд проекта:
- адрес — **https://accounting.dev.vvpreo.net** (dev-nginx, Basic-аутентификация) → порт `3700` этой машины;
- контейнер `vvpreo--accounting-app-dev` из локально собранного образа `a2b-accounting:local`;
- данные — `.tmp/dev-data` (не коммитится);
- порт публикуется на `127.0.0.1` и на `172.17.0.1` (через этот адрес до него достаёт контейнер dev-nginx).

Обновить стенд до текущего кода:

```bash
docker build --build-arg APP_ENV=dev -t a2b-accounting:local .
docker rm -f vvpreo--accounting-app-dev
docker run -d --name vvpreo--accounting-app-dev --restart unless-stopped \
  -p 127.0.0.1:3700:8080 -p 172.17.0.1:3700:8080 \
  -v "$PWD/.tmp/dev-data:/data" a2b-accounting:local
```
