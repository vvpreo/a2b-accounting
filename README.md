# A2B Finances

> Last updated: 2026-04-29 @ `9993efd`

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

Если в корне проекта есть `.envrc` с `FINANCES_DATA_DIR`, direnv подхватит её автоматически (по умолчанию `./data`).

## Architecture

Два слоя, общающиеся через Tauri `invoke`:

```
┌──────────────────────────────────────────────┐
│  Webview (React 19 + TS + Vite)              │
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
- При импорте обнаруживаются разрывы цепочки баланса с БД и в самом файле — для их закрытия автоматически добавляются «корректирующие» транзакции с флагом `is_correcting = 1`. Они помечены курсивом в UI и подразумевают, что пользователь позже заменит их реальными.
- Миграции — массив `(version, name, sql)` в `db.rs`, применяются инкрементально через таблицу `schema_migrations`.
- Настройки пользователя — таблица `app_settings (key, value)` + команды `get_setting` / `set_setting`. Сейчас один ключ — `locale`.
- i18n — свой Context на React + JSON-файлы в [src/i18n/locales/](src/i18n/locales/). Стартовые языки: `ru`, `en`. Default = системный язык через `navigator.language`, fallback — `en`. Новый язык = новый JSON-файл + запись в `LANGUAGES`.

## Data Model

```sql
accounts          (id, name, bank, currency, account_number, owner_name, created_at)
                   UNIQUE(bank, account_number)
import_batches    (id, account_id → accounts, imported_at, source_filename, row_count,
                   timezone_offset)
                   ON DELETE CASCADE
transactions      (id, account_id → accounts, import_batch_id → import_batches,
                   occurred_at_utc, credit, debit, balance,
                   peer, bank_description, comment, is_correcting)
                   CHECK (credit = 0 OR debit = 0)
                   ON DELETE CASCADE (обе FK)
app_settings      (key, value)              — пользовательские настройки (locale и т.п.)
schema_migrations (version, name, applied_at)
```

`bank_description` — строка из выгрузки банка (read-only); `comment` — пользовательская заметка, редактируется инлайн в таблице транзакций.

## Repository Structure

```
finances-v2/
├── src/                                React + TS фронтенд
│   ├── App.tsx                         корневая разводка по табам
│   ├── App.css                         все стили (без Tailwind)
│   ├── main.tsx                        bootstrap: загрузка локали из БД + I18nProvider
│   ├── components/
│   │   ├── Tabs.tsx                    верхняя навигация по вкладкам
│   │   └── MultiSelectDropdown.tsx     дропдаун с чекбоксами и Apply (счета, фильтры, колонки)
│   ├── i18n/
│   │   ├── index.ts                    Context, Provider, хуки useT/useTPlural, реестр LANGUAGES
│   │   └── locales/
│   │       ├── ru.json                 русские переводы
│   │       └── en.json                 английские переводы
│   ├── lib/
│   │   ├── api.ts                      типизированные обёртки над invoke
│   │   ├── account-presets.ts          справочник банков-пресетов (имя, валюта по умолчанию)
│   │   ├── currencies.ts               справочник валют (фиат + крипта)
│   │   ├── csv.ts                      парсер CSV через papaparse
│   │   └── money.ts                    форматирование сумм для UI
│   └── pages/
│       ├── Accounts.tsx                таблица счетов, модалки create/edit, sub-view с панелью «Загрузки»
│       ├── Transactions.tsx            фильтр-бар + таблица: sticky-шапка, фиксированные колонки,
│       │                               разделители месяцев, день недели, инлайн-редактор комментария
│       ├── ImportDialog.tsx            два шага: выбор/вставка CSV → превью с ошибками и импортом
│       ├── Categories.tsx              заглушка TBD
│       └── Settings.tsx                селектор языка (хранится в БД)
├── src-tauri/                          Rust backend
│   ├── Cargo.toml                      зависимости: rusqlite, rust_decimal, chrono, thiserror
│   ├── tauri.conf.json                 конфигурация окна и бандла
│   ├── capabilities/default.json       permissions webview
│   ├── migrations/
│   │   ├── 001_init.sql                accounts, import_batches, transactions
│   │   ├── 002_add_account_name.sql    accounts.name
│   │   ├── 003_add_transaction_peer.sql        transactions.peer
│   │   ├── 004_move_timezone_to_import_batch.sql    timezone offset на уровне batch
│   │   ├── 005_add_app_settings.sql    таблица app_settings (key, value)
│   │   ├── 006_replace_description_columns.sql описание банка + комментарий пользователя
│   │   └── 007_add_transaction_is_correcting.sql флаг корректирующих транзакций
│   ├── .taurignore                     защита от dev-watcher лупа на файлах БД
│   └── src/
│       ├── main.rs                     точка входа
│       ├── lib.rs                      Tauri Builder + регистрация команд + init data dir
│       ├── db.rs                       открытие БД, миграции, тесты
│       ├── money.rs                    parse_minor / format_minor + unit-тесты
│       ├── accounts.rs                 create/list/update/delete + команды
│       ├── transactions.rs             import (с авто-корректировками) / list / delete_batch /
│       │                               validate_balance_chain / validate_import_preview /
│       │                               update_transaction_comment
│       └── settings.rs                 get_setting / set_setting (UPSERT в app_settings)
├── scripts/
│   ├── dev.sh                          запуск dev (проверяет FINANCES_DATA_DIR, нормализует путь)
│   └── build.sh                        релизная сборка
├── samples/
│   ├── valid-5-rows.csv                пример корректной цепочки балансов
│   └── invalid-balance-gap.csv         пример с намеренным разрывом
├── docs/plans/                         планы фич (читаются по ссылкам из TODO.md)
├── TODO.md                             очередь задач (TODO / PLANNED / TO REVIEW / DONE)
└── .envrc                              FINANCES_DATA_DIR="$(pwd)/data" (direnv)
```

## UI Overview

- **Вкладки**: Категории · Счета · Транзакции · Настройки. Категории — заглушка.
- **Счета**: таблица счетов; кнопка «Добавить счёт» внизу страницы открывает модалку. У каждой строки — действия «Транзакции →» (переход с фильтром по этому счёту) и «Подробнее» (sub-view с пакетами импорта и проверкой цепочки баланса).
- **Транзакции**:
  - Свёртываемая панель фильтров (Счета · С · По · Фильтр типа · Колонки) с кнопкой «Импортировать транзакции» в правом краю. Toggle-черточка по центру всегда на одном и том же месте, независимо от состояния панели.
  - Сортировка ASC: старые сверху, свежие снизу; при загрузке/смене фильтров скролл автоматически уезжает в самый низ.
  - Sticky-шапка таблицы. Первые 5 колонок (Счёт · Дата · Поступление · Списание · Баланс) фиксированной ширины. После «Баланса» — серый разделитель: справа идут опциональные колонки (Категория-заглушка, Комментарий, Контрагент, Описание банка), управляются через дропдаун «Колонки». По умолчанию видны только Категория и Комментарий.
  - Разделители месяцев — sticky-строки прямо под шапкой; в дате каждой транзакции в скобках — день недели сокращённо до 2 букв (`(ПН)`, `(СБ)` и т.д.).
- **Импорт**: глобальная двухшаговая модалка `ImportDialog` — выбор CSV-файла или вставка текста, затем превью с подсветкой проблем (дубли с БД / в файле, разрывы баланса). Импорт создаёт `import_batch` и при необходимости автоматические корректирующие транзакции.

## Tauri Commands

Регистрируются в [src-tauri/src/lib.rs](src-tauri/src/lib.rs) и вызываются из [src/lib/api.ts](src/lib/api.ts):

- `data_dir` — путь к директории данных
- `create_account` · `list_accounts` · `update_account` · `delete_account`
- `import_transactions` · `list_transactions` · `list_import_batches` · `delete_import_batch`
- `validate_balance_chain` · `validate_import_preview` · `update_transaction_comment`
- `get_setting` · `set_setting`

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
Юнит-тесты покрывают: парсинг/форматирование денег, идемпотентность миграций, FK-каскад, CHECK-constraint, валидацию цепочки балансов, фильтрацию `list_transactions` по `account_ids`.

Для фронта — type-check через `npx tsc --noEmit` (или `npm run build`, который делает `tsc && vite build`).

### Ручная проверка импорта
В папке `samples/` есть два CSV-сэмпла — валидная цепочка из 5 строк и цепочка с намеренным разрывом баланса. Прогнать через кнопку «Импортировать транзакции» в фильтр-баре на вкладке «Транзакции».

### CSV-формат импорта
```
occurred_at,credit,debit,balance,peer,bank_description,comment
2026-04-01T10:15:00+03:00,,150.00,12340.50,Coffee shop,Morning coffee,
2026-04-01T18:00:00+03:00,50000.00,,62340.50,Employer,,
```
- `occurred_at` — ISO-8601, с offset или без (тогда применяется дефолтный offset, выбранный в диалоге импорта). Обязательно.
- `balance` — баланс ПОСЛЕ операции. Обязательно.
- `credit` / `debit` — ровно одно из двух заполнено (пустое = 0).
- `peer` — контрагент.
- `bank_description` — текст из выгрузки банка.
- `comment` — пользовательская заметка (можно оставить пустым и заполнить инлайн в таблице).

Поддерживаются разделители: запятая, табуляция, точка с запятой.

## Configuration

### Переменные окружения
- **`FINANCES_DATA_DIR`** (обязательная) — абсолютный путь к директории для всех данных приложения. В этой директории создаются `finances.db` + WAL-файлы. Если путь не существует — создаётся. Если переменная не задана — приложение падает с понятным сообщением.

### Замечания по dev-режиму
- Если `FINANCES_DATA_DIR` указывает внутрь `src-tauri/`, dev-watcher зациклится на изменениях файлов БД. `dev.sh` нормализует относительные пути к корню проекта, а `src-tauri/.taurignore` страхует от повторения.
- WAL-режим SQLite включён (`PRAGMA journal_mode=WAL`) — рядом с `.db` появятся `-wal` и `-shm` файлы.

## Development

- **Node.js** ≥ 20, **Rust** stable через `rustup`.
- Тесты Rust: `cd src-tauri && cargo test --lib`. Для фронта — type-check через `npm run build` или `npx tsc --noEmit`.
- Нативные JS-диалоги (`window.confirm`, `window.alert`, `window.prompt`) в Tauri webview не работают — используем инлайн-подтверждения в UI.
- Деньги никогда не ходят через `number` с плавающей точкой — только строки `"123.45"` на границе и `i64` копейки внутри.

## Current Status

Готов фундамент: модель данных (счета, транзакции, батчи импорта), двухшаговый импорт CSV с валидацией цепочки балансов и автоматическими корректирующими проводками, CRUD по счетам, удаление батчей, инлайн-редактирование комментариев. Транзакционная вкладка отполирована: sticky-шапка/разделители месяцев, фиксированные колонки, разделитель основных/опциональных колонок, день недели, авто-скролл в низ. Всё, кроме базового bootstrap, ожидает ручной приёмки в **TO REVIEW**.

Не вошло в MVP:
- Категории (только заглушка вкладки + плейсхолдер-колонка), теги, отчёты.
- Мультивалютные переводы между счетами.
- Специфические парсеры под каждый банк (сейчас только универсальный CSV).
- Редактирование произвольных полей отдельной транзакции (только `comment`).
- Валюты со scale ≠ 2 (JPY, KWD).
- Шифрование БД.
