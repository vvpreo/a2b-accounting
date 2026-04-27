# finances-v2

> Last updated: 2026-04-24 @ `a061a88`

Десктоп-приложение для учёта и планирования личных финансов В3П. Табличный интерфейс, локальная БД, офлайн-first, фокус на скорость разработки и ручной ввод/импорт банковских выгрузок.

## Quick Start

```bash
# 1. Предварительные требования (macOS):
#    - Node.js ≥ 20
#    - Rust stable (rustup.rs)
#    - Xcode Command Line Tools (xcode-select --install)

# 2. Установка зависимостей
npm install

# 3. Запуск в dev-режиме (watcher + hot reload)
export FINANCES_DATA_DIR="$HOME/.finances-v2"
./scripts/dev.sh
```

Если в корне проекта есть `.envrc` с `FINANCES_DATA_DIR`, direnv подхватит её автоматически.

## Architecture

Два слоя, общающиеся через Tauri `invoke`:

```
┌──────────────────────────────────────────────┐
│  Webview (React 19 + TS + Vite)             │
│    src/pages/      — экраны                  │
│    src/lib/api.ts  — типизированные вызовы   │
│    src/lib/csv.ts  — парсинг CSV (papaparse) │
└───────────────────┬──────────────────────────┘
                    │  invoke(cmd, args)
┌───────────────────▼──────────────────────────┐
│  Rust backend (Tauri 2)                      │
│    src-tauri/src/accounts.rs                 │
│    src-tauri/src/transactions.rs             │
│    src-tauri/src/db.rs     — миграции        │
│    src-tauri/src/money.rs  — копейки ⇄ "123.45" │
└───────────────────┬──────────────────────────┘
                    │  rusqlite (Mutex<Connection>)
┌───────────────────▼──────────────────────────┐
│  SQLite                                      │
│    $FINANCES_DATA_DIR/finances.db            │
└──────────────────────────────────────────────┘
```

Принципы:
- Вся SQL — на Rust-стороне; TypeScript не знает про схему.
- Деньги — `INTEGER` в минимальных единицах валюты (копейки/центы), scale = 2. Конверсия через `rust_decimal` в Rust и строки на фронте.
- Даты — `occurred_at_utc` (ISO-8601 UTC для сравнения) у каждой транзакции, плюс `timezone_offset` (`+03:00`) на уровне импорт-батча: все строки одной выписки разделяют один offset, дублировать его в каждой строке не имеет смысла.
- Импорт транзакций группируется в батч (`import_batches`); удаление батча каскадно удаляет все его транзакции.
- Миграции — массив `(version, name, sql)` в `db.rs`, применяются инкрементально через таблицу `schema_migrations`.

## Data Model

```sql
accounts         (id, name, bank, currency, account_number, owner_name, created_at)
                  UNIQUE(bank, account_number)
import_batches   (id, account_id → accounts, imported_at, source_filename, row_count,
                  timezone_offset)
                  ON DELETE CASCADE
transactions     (id, account_id → accounts, import_batch_id → import_batches,
                  occurred_at_utc, peer, credit, debit, balance, description)
                  CHECK (credit = 0 OR debit = 0)
                  ON DELETE CASCADE (обе FK)
schema_migrations (version, name, applied_at)
```

## Repository Structure

```
finances-v2/
├── src/                              React + TS фронтенд
│   ├── App.tsx                       state-based роутинг (Accounts ↔ Transactions)
│   ├── App.css                       стили (без Tailwind)
│   ├── lib/
│   │   ├── api.ts                    типизированные обёртки над invoke
│   │   ├── banks.ts                  справочник банков (сейчас: Bangkok Bank)
│   │   ├── currencies.ts             справочник валют (155 ISO-кодов + BTC/ETH/USDT)
│   │   └── csv.ts                    парсер CSV через papaparse
│   └── pages/
│       ├── Accounts.tsx              список счетов, форма создания, модалка редактирования/удаления
│       ├── AccountTransactions.tsx   таблица транзакций + панель загрузок
│       └── ImportDialog.tsx          выбор CSV + превью + импорт
├── src-tauri/                        Rust backend
│   ├── Cargo.toml                    зависимости: rusqlite, rust_decimal, chrono, thiserror
│   ├── tauri.conf.json               конфигурация окна и бандла
│   ├── capabilities/default.json     permissions webview
│   ├── migrations/
│   │   ├── 001_init.sql              accounts, import_batches, transactions
│   │   ├── 002_add_account_name.sql  accounts.name
│   │   ├── 003_add_transaction_peer.sql  transactions.peer
│   │   └── 004_move_timezone_to_import_batch.sql  import_batches.timezone_offset, drop transactions.occurred_at_tz
│   ├── .taurignore                   защита от dev-watcher лупа на файлах БД
│   └── src/
│       ├── main.rs                   точка входа
│       ├── lib.rs                    Tauri Builder + регистрация команд
│       ├── db.rs                     открытие БД, миграции, тесты
│       ├── money.rs                  parse_minor / format_minor + unit-тесты
│       ├── accounts.rs               create/list/update/delete + команды
│       └── transactions.rs           import/list/delete_batch/validate + команды + тесты
├── scripts/
│   ├── dev.sh                        запуск dev (проверяет FINANCES_DATA_DIR, нормализует в абсолют)
│   └── build.sh                      релизная сборка
├── samples/
│   ├── valid-5-rows.csv              пример корректной цепочки балансов
│   └── invalid-balance-gap.csv       пример с намеренным разрывом
├── docs/plans/
│   └── data-model-and-import.md      план фундаментальной фичи
├── TODO.md                           очередь задач
└── .envrc                            FINANCES_DATA_DIR="$(pwd)/data" (direnv)
```

## Usage

### Режим разработки
```bash
./scripts/dev.sh
```
Скрипт проверяет `FINANCES_DATA_DIR`, конвертирует относительный путь в абсолютный, подгружает Rust в PATH и запускает `npm run tauri dev` (Vite + `cargo run`).

### Релизная сборка
```bash
./scripts/build.sh
```
На выходе — `.app` и `.dmg` под macOS в `src-tauri/target/release/bundle/`.

### Тесты
```bash
cd src-tauri && cargo test --lib
```
Юнит-тесты покрывают: парсинг/форматирование денег, идемпотентность миграций, FK-каскад, CHECK-constraint, валидацию цепочки балансов.

### Ручная проверка импорта
В папке `samples/` есть два CSV-сэмпла — валидная цепочка из 5 строк и цепочка с намеренным разрывом баланса. Используй их через кнопку «Импорт транзакций» на странице счёта.

### CSV-формат импорта
```
occurred_at,peer,credit,debit,balance,description
2026-04-01T18:00:00+03:00,Employer,50000.00,,58299.50,Зарплата за март
2026-04-02T09:00:00+03:00,Пятёрочка,,3500.00,54799.50,Продукты
```
- `occurred_at` — ISO-8601 с offset (обязательно)
- `credit` / `debit` — ровно одно из двух заполнено (пустое = 0)
- `balance` — баланс ПОСЛЕ операции
- `peer` — контрагент (источник / адресат)
- `description` — произвольное описание

## Configuration

### Переменные окружения
- **`FINANCES_DATA_DIR`** (обязательная) — абсолютный путь к директории для всех данных приложения. В этой директории создаются `finances.db` + WAL-файлы. Если путь не существует — создаётся. Если переменная не задана — приложение падает с понятным сообщением.

### Замечания по dev-режиму
- Если `FINANCES_DATA_DIR` указывает внутрь `src-tauri/`, dev-watcher зациклится на изменениях файлов БД. `dev.sh` нормализует относительные пути к корню проекта, а `src-tauri/.taurignore` страхует от повторения.
- WAL-режим SQLite включён (`PRAGMA journal_mode=WAL`) — рядом с `.db` появятся `-wal` и `-shm` файлы.

## Development

- **Node.js** ≥ 20, **Rust** stable через `rustup`.
- Тесты Rust: `cd src-tauri && cargo test --lib`. Для фронта пока только tsc-проверка через `npm run build`.
- Нативные JS-диалоги (`window.confirm`, `window.alert`, `window.prompt`) в Tauri webview не работают — используем инлайн-подтверждения в UI.
- Деньги никогда не ходят через `number` с плавающей точкой — только строки `"123.45"` на границе и `i64` копейки внутри.

## Current Status

Готов фундамент: модель данных (счета, транзакции, батчи импорта), механизм импорта CSV с валидацией цепочки балансов, CRUD по счетам, удаление батчей загрузок, справочники валют и банков. Всё в статусе **TO REVIEW** до ручной приёмки пользователем.

Не вошло в MVP:
- Категории, теги, отчёты.
- Мультивалютные переводы между счетами.
- Специфические парсеры под каждый банк (сейчас только универсальный CSV).
- Редактирование отдельной транзакции — пока только bulk-импорт + удаление батча.
- Валюты со scale ≠ 2 (JPY, KWD).
- Шифрование БД.
