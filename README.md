# A2B Finances

> Last updated: 2026-04-29 @ `0d42a4d`

Десктоп-приложение для учёта и планирования личных финансов В3П. Табличный интерфейс, локальная БД SQLite, офлайн-first, фокус на скорость разработки и ручной ввод/импорт банковских выгрузок.

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

## Установка собранного DMG

Каждый push в `main` автоматически собирает Apple Silicon DMG и публикует его как rolling-релиз `latest` (workflow [.github/workflows/release-latest.yml](.github/workflows/release-latest.yml)). Свежий билд всегда доступен по тегу `latest`.

```bash
# 1. Скачать (репо приватный — нужен gh CLI с авторизацией)
gh release download latest \
  --repo <owner>/<repo> \
  --pattern "*.dmg" --clobber

# 2. Смонтировать и установить
hdiutil attach A2B-Finances-latest-arm64.dmg
cp -R "/Volumes/A2B Finances/A2B Finances.app" /Applications/
hdiutil detach "/Volumes/A2B Finances"

# 3. Снять карантин (приложение не подписано Apple ID)
xattr -cr "/Applications/A2B Finances.app"

# 4. Запустить
open "/Applications/A2B Finances.app"
```

Альтернативно при первом запуске можно открыть приложение через ПКМ → «Открыть» в Finder и согласиться на запуск неподписанного бинаря.

**Где живут данные:** `~/Library/Application Support/net.vvpreo.finances/finances.db` (плюс WAL-файлы). Это путь по умолчанию для production-DMG. Между обновлениями приложение сохраняет БД и применяет новые миграции на старте автоматически (см. `db.rs` и идемпотентную таблицу `schema_migrations`).

## Architecture

Два слоя, общающиеся через Tauri `invoke`:

```
┌──────────────────────────────────────────────┐
│  Webview (React 19 + TS + Vite)             │
│    src/pages/      — экраны                  │
│    src/components/ — переиспользуемые блоки  │
│    src/lib/api.ts  — типизированные вызовы   │
│    src/lib/csv.ts  — парсинг CSV (papaparse) │
│    src/lib/colors.ts       — палитра + оттенки │
│    src/lib/distribution.ts — каскадные доли   │
│    src/lib/category-tree.ts — построение дерева │
└───────────────────┬──────────────────────────┘
                    │  invoke(cmd, args)
┌───────────────────▼──────────────────────────┐
│  Rust backend (Tauri 2)                      │
│    src-tauri/src/accounts.rs                 │
│    src-tauri/src/transactions.rs             │
│    src-tauri/src/categories.rs               │
│    src-tauri/src/transaction_categories.rs   │
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
- Деньги — `INTEGER` в минимальных единицах валюты (копейки/центы), scale = 2. Конверсия через `rust_decimal` в Rust и строки на фронте; на фронте есть `parseMoneyToMinor` / `formatMinorAsMoney` для копеечных операций (доли, слайдеры).
- Даты — `occurred_at_utc` (ISO-8601 UTC для сравнения и хранения) у каждой транзакции, плюс `timezone_offset` (`+03:00`) на уровне импорт-батча. В UI даты отображаются в локальной таймзоне ОС, а на hover ячейки показывается оригинальный UTC-таймстамп.
- Импорт транзакций группируется в батч (`import_batches`); удаление батча каскадно удаляет все его транзакции.
- Миграции — массив `(version, name, sql)` в `db.rs`, применяются инкрементально через таблицу `schema_migrations`.
- Настройки пользователя — таблица `app_settings (key, value)` + команды `get_setting` / `set_setting`. Сейчас один ключ — `locale`.
- Категории — отдельная таблица с произвольной вложенностью (`parent_id`); поле `kind ∈ {income, expense}` хранится на каждой строке и наследуется потомками; UI ограничивает дерево тремя уровнями.
- Привязка транзакции к категориям — `transaction_categories(transaction_id, category_id, share_minor, position)`. Сумма долей `≤` сумме транзакции; разница — виртуальная «Без категории», вычисляется на лету. Атомарная замена через `set_transaction_categories`.
- Связи переводов между своими счетами — `transaction_links(txn_a_id, txn_b_id)`. Хранятся каноничной парой `txn_a_id < txn_b_id`, каждая транзакция участвует максимум в одной связи. Бэкенд (`link_transactions`) проверяет: разные счета, противоположное направление (одна credit, другая debit), нет других существующих связей. Категории связанной транзакции остаются как есть. Отчёт исключает транзакции из агрегации только если *обе стороны* связи попали в его выбор счетов и диапазон дат — иначе видимая сторона учитывается обычным образом.
- Состояние окна (позиция, размер, maximized, fullscreen) сохраняется между запусками плагином `tauri-plugin-window-state`.
- Импорт построен поверх **универсального CSV** (`occurred_at,credit,debit,balance,peer,bank_description,comment`). Под каждый банк-пресет регистрируется плагин в [src/lib/import-formats/](src/lib/import-formats/), который конвертирует свою выгрузку (CSV/XLS/PDF) в универсальный CSV — дальше работает общий конвейер валидации/превью. Это держит всю логику дубликатов и проверки цепочки балансов в одном месте и делает тесты парсеров тривиальной строковой сверкой.
- i18n — свой Context на React + JSON-файлы в [src/i18n/locales/](src/i18n/locales/). Стартовые языки: `ru`, `en`. Default = системный язык через `navigator.language`, fallback — `en`. Новый язык = новый JSON-файл + запись в `LANGUAGES`.

## Data Model

```sql
accounts                 (id, name, bank, currency, account_number, owner_name, created_at)
                          UNIQUE(bank, account_number)
import_batches           (id, account_id → accounts, imported_at, source_filename, row_count,
                          timezone_offset)
                          ON DELETE CASCADE
transactions             (id, account_id → accounts, import_batch_id → import_batches,
                          occurred_at_utc, peer, credit, debit, balance,
                          bank_description, comment, is_correcting)
                          CHECK (credit = 0 OR debit = 0)
                          ON DELETE CASCADE (обе FK)
categories               (id, name, color, kind, parent_id → categories, created_at)
                          CHECK (kind IN ('income','expense'))
                          UNIQUE(parent_id, name)
                          ON DELETE CASCADE (parent_id)
transaction_categories   (transaction_id → transactions, category_id → categories,
                          share_minor, position)
                          PRIMARY KEY (transaction_id, category_id)
                          CHECK (share_minor > 0)
                          ON DELETE CASCADE (обе FK)
transaction_links        (id, txn_a_id → transactions, txn_b_id → transactions,
                          created_at)
                          CHECK (txn_a_id < txn_b_id)
                          UNIQUE (txn_a_id), UNIQUE (txn_b_id)
                          ON DELETE CASCADE (обе FK)
app_settings             (key, value)
schema_migrations        (version, name, applied_at)
```

## Repository Structure

```
finances-v2/
├── src/                              React + TS фронтенд
│   ├── App.tsx                       табы; на старте автоматически выбирает Транзакции, если они есть, иначе Счета
│   ├── App.css                       стили (без Tailwind)
│   ├── main.tsx                      bootstrap: загрузка локали из БД + I18nProvider
│   ├── components/
│   │   ├── Tabs.tsx                  верхняя навигация (Счета/Транзакции слева, Категории/Настройки справа)
│   │   ├── MultiSelectDropdown.tsx   универсальный multi-select
│   │   ├── CategoryPickerPopover.tsx anchored-поповер выбора категории с поиском и kind-фильтром
│   │   └── CategoryDistributionModal.tsx модалка распределения долей по категориям с каскадными слайдерами
│   ├── i18n/
│   │   ├── index.ts                  Context, Provider, хуки useT/useTPlural, реестр LANGUAGES
│   │   └── locales/
│   │       ├── ru.json               русские переводы
│   │       └── en.json               английские переводы
│   ├── lib/
│   │   ├── api.ts                    типизированные обёртки над invoke
│   │   ├── account-presets.ts        пресеты банков (валюта по умолчанию, дефолтный TZ-offset, список поддерживаемых форматов выгрузок)
│   │   ├── colors.ts                 палитра категорий + генерация оттенков из родительского hue
│   │   ├── category-tree.ts          buildTree/flattenTree (общая утилита для Categories.tsx и пикера)
│   │   ├── currencies.ts             справочник валют (ISO-коды + крипта)
│   │   ├── import-formats/           реестр парсеров выгрузок (плагины формата)
│   │   │   ├── index.ts                    реестр + parseByFormat(formatId, text, t)
│   │   │   ├── types.ts                    общие типы (CsvParseResult, ImportFormatPlugin, Translate)
│   │   │   ├── universal-csv.ts            generic-csv-v1: универсальный CSV через papaparse
│   │   │   ├── kasikorn-csv-v1.ts          Kasikorn (KBank): bank CSV → universal CSV → universal-csv
│   │   │   └── bangkok-bank-csv-v1.ts      Bangkok Bank (BBL): bank CSV → universal CSV → universal-csv
│   │   ├── distribution.ts           equalSplit/addEqualToCategorized/setShareAt и т.д. — чистая математика долей в копейках
│   │   └── money.ts                  formatMoney + parseMoneyToMinor + formatMinorAsMoney
│   └── pages/
│       ├── Accounts.tsx              список счетов, форма, sub-view деталей с панелью «Загрузки» и валидацией
│       ├── Transactions.tsx          таблица транзакций с фильтрами, sticky-шапкой, группировкой по месяцам и колонкой категорий
│       ├── transactions/
│       │   └── CategoriesCell.tsx    ячейка категорий: пропорциональные полосы, hover-tooltip, инлайн-пикер, кнопка-карандаш
│       ├── Categories.tsx            CRUD категорий: две секции (Доходы/Расходы), дерево до 3 уровней, hover-кнопки + и ✎
│       ├── Settings.tsx              селектор языка (хранится в БД)
│       └── ImportDialog.tsx          двухшаговый мастер импорта CSV (preview + import)
├── src-tauri/                        Rust backend
│   ├── Cargo.toml                    зависимости: rusqlite, rust_decimal, chrono, thiserror, tauri-plugin-window-state
│   ├── tauri.conf.json               конфигурация окна и бандла
│   ├── capabilities/default.json     permissions webview
│   ├── migrations/
│   │   ├── 001_init.sql              accounts, import_batches, transactions
│   │   ├── 002_add_account_name.sql  accounts.name
│   │   ├── 003_add_transaction_peer.sql  transactions.peer
│   │   ├── 004_move_timezone_to_import_batch.sql  import_batches.timezone_offset, drop transactions.occurred_at_tz
│   │   ├── 005_add_app_settings.sql  таблица app_settings (key, value)
│   │   ├── 006_replace_description_columns.sql  transactions.bank_description + transactions.comment
│   │   ├── 007_add_transaction_is_correcting.sql  transactions.is_correcting
│   │   ├── 008_add_categories.sql    таблица categories (kind, parent_id, color)
│   │   └── 009_add_transaction_categories.sql  таблица transaction_categories
│   ├── .taurignore                   защита от dev-watcher лупа на файлах БД
│   └── src/
│       ├── main.rs                   точка входа
│       ├── lib.rs                    Tauri Builder + регистрация команд + плагин window-state
│       ├── db.rs                     открытие БД, миграции, тесты
│       ├── money.rs                  parse_minor / format_minor + unit-тесты
│       ├── accounts.rs               create/list/update/delete + команды
│       ├── transactions.rs           import/list (с фильтром по account_ids)/delete_batch/validate/preview
│       ├── categories.rs             create/list/update/delete + наследование kind + тесты
│       ├── transaction_categories.rs set/list с проверкой kind, инварианта суммы и каскадов + тесты
│       └── settings.rs               get_setting / set_setting (UPSERT в app_settings)
├── scripts/
│   ├── dev.sh                        запуск dev (проверяет FINANCES_DATA_DIR, нормализует в абсолют)
│   └── build.sh                      релизная сборка
├── samples/                          примеры выгрузок (для ручного теста импорта)
│                                     структура: samples/<preset-id>/<format-id>/<filename>
│                                     — файлы реальных банковских выгрузок не коммитятся (PII)
├── docs/plans/                       планы крупных фич
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
55 юнит-тестов покрывают: парсинг/форматирование денег, идемпотентность миграций, FK-каскад, CHECK-constraint, валидацию цепочки балансов, поведение категорий (CHECK на kind, UNIQUE сиблингов, каскадное удаление) и привязок транзакций к категориям (kind-матч, инвариант суммы, атомарная замена, оба каскада).

Фронтенд — `npm test` (Vitest) + tsc-проверка через `npm run build`. Тесты парсеров банковских выгрузок держат фикстуры **inline** в коде теста: реальные выгрузки не коммитятся, поэтому привязывать тесты к файлам в `samples/` нельзя.

### Ручная проверка импорта
В папке `samples/` лежат сэмплы — валидная цепочка / разрыв баланса для generic-формата, плюс по подпапке на каждый банковский пресет (`samples/<preset-id>/<format-id>/`). Реальные банковские выгрузки в репозиторий **не комитятся** (содержат PII) — кладите свои локально, в коммит они не должны попасть.

### Поддерживаемые форматы выгрузок

| Пресет | Format ID | Источник |
|---|---|---|
| Generic | `generic-csv-v1` | Любой CSV в нашем универсальном формате |
| Bangkok Bank | `bangkok-bank-csv-v1` | Выгрузка `MyDownLoad*.csv` из BBL iBanking / Bualuang mBanking |
| Kasikorn Bank | `kasikorn-csv-v1` | Выгрузка K-DEPOSIT `resultFile_*.csv` из K PLUS / KBank web |

Для **Kasikorn** парсер автоматически:
- пропускает 12 строк шапки (реквизиты, период, итоги) и строку `Beginning Balance`;
- нормализует числа `"90,000.00"` → `90000.00`;
- разворачивает дату `DD-MM-YY` в `YYYY-MM-DD` (XXI век);
- собирает `bank_description` из `Description · Channel · Details`;
- извлекает `peer` из `Details` (`From <…>` / `To <…>` / `Paid for Ref X#### <…>`); для системных `Ref Code …` — `peer` пустой.

Для **Bangkok Bank** парсер автоматически:
- пропускает шапку (Account/Card numbers, Ledger/Available Balance), строку `Total` и Disclaimer;
- нормализует числа `"12,030.00"` → `12030.00`;
- парсит `"DD MMM YYYY HH:MM"` (англ. месяцы, e.g. `27 Apr 2026 11:50`) → `YYYY-MM-DDTHH:MM:00`;
- разворачивает порядок строк (BBL экспортирует от новых к старым) — итоговый universal CSV в хронологическом порядке;
- собирает `bank_description` из `Description · Channel` (e.g. `Payment for Goods /Services · MOB`);
- `peer` оставляет пустым — выгрузка не содержит контрагента.

Time-zone offset выгрузка не указывает; ImportDialog подставляет дефолт из пресета (`+07:00` для Kasikorn/Bangkok Bank).

### CSV-формат импорта
```
occurred_at,credit,debit,balance,peer,bank_description,comment
2026-04-01T10:15:00+03:00,,150.00,12340.50,Кофейня,Утренний кофе,
2026-04-02T09:00:00+03:00,50000.00,,62340.50,Employer,Зарплата,
```
- `occurred_at` — ISO-8601 (offset обязателен; если опущен, применяется дефолтный из мастера)
- `credit` / `debit` — ровно одно из двух заполнено (пустое = 0)
- `balance` — баланс ПОСЛЕ операции
- `peer` — контрагент (источник / адресат)
- `bank_description` / `comment` — два независимых текстовых поля

## Configuration

### Переменные окружения
- **`FINANCES_DATA_DIR`** (опциональная, override) — абсолютный путь к директории для данных приложения. Если переменная не задана, приложение использует стандартный macOS-путь `~/Library/Application Support/net.vvpreo.finances/` (через `AppHandle::path().app_data_dir()`). В обеих ветках в директории создаются `finances.db` + WAL-файлы; путь создаётся, если не существует. Override используется в dev-режиме (через `.envrc`), чтобы не мешать продакшн-данным DMG-сборки.

### Замечания по dev-режиму
- Если `FINANCES_DATA_DIR` указывает внутрь `src-tauri/`, dev-watcher зациклится на изменениях файлов БД. `dev.sh` нормализует относительные пути к корню проекта, а `src-tauri/.taurignore` страхует от повторения.
- WAL-режим SQLite включён (`PRAGMA journal_mode=WAL`) — рядом с `.db` появятся `-wal` и `-shm` файлы.
- Состояние окна сохраняется плагином `tauri-plugin-window-state` рядом с appdata; чтобы сбросить геометрию, удалите соответствующий файл состояния.

## Development

- **Node.js** ≥ 20, **Rust** stable через `rustup`.
- Тесты Rust: `cd src-tauri && cargo test --lib`. Тесты фронта: `npm test` (Vitest) + tsc-проверка через `npm run build`.
- Нативные JS-диалоги (`window.confirm`, `window.alert`, `window.prompt`) в Tauri webview не работают — используем инлайн-подтверждения в UI.
- Деньги никогда не ходят через `number` с плавающей точкой — только строки `"123.45"` на границе и `i64` копейки внутри.
- Действия (создать счёт, импортировать транзакции) живут в шапке соответствующего экрана — глобального тулбара больше нет.
- При старте приложение делает один `listTransactions()` и переключается на вкладку Транзакции, если они есть; иначе остаётся на Счетах.

## Current Status

Готовый функционал:
- Модель данных и схема миграций (счета, транзакции, батчи импорта, настройки, категории, привязки категорий к транзакциям).
- CRUD по счетам с пресетами банков и валидацией цепочки балансов на детальной странице.
- Двухшаговый мастер импорта CSV: предпросмотр с подсветкой проблем (дубли, разрывы), автоматическое создание корректирующих транзакций.
- Вкладка «Транзакции»: multi-select фильтр по счетам, sticky-шапка, группировка по месяцам в локальном времени, динамическая ширина первых 5 колонок (по контенту), эластичная колонка комментария, локальное отображение даты с UTC-таймстампом в title-tooltip.
- Колонка «Категория» в таблице транзакций: пропорциональные цветные полосы, серая полоса «Без категории» для нераспределённого остатка, hover-tooltip с точными суммами и процентами, инлайн-пикер выбора категории с поиском и фильтром по kind, иконка-карандаш открывает модалку с каскадными слайдерами для тонкой настройки распределения.
- Справочник категорий: иерархия доходов/расходов до трёх уровней в UI, палитра цветов с авто-производными оттенками, компактные иконки + и ✎ при наведении на строку.
- Связи переводов между своими счетами: колонка 🔗 на вкладке «Транзакции», двухкликовая привязка с проверками (разные счета, противоположное направление, не повторно), разрыв связи через подтверждение. В отчёте взаимно покрывающиеся пары исключаются автоматически.
- i18n (ru/en), хранение выбранного языка в БД.
- Сохранение позиции и размера окна между запусками.

В очереди (`TO REVIEW` в [TODO.md](TODO.md)):
- Приёмка справочника категорий.
- Приёмка модели данных и импорта.

Не вошло в MVP:
- Авто-категоризация (правила для автоматического проставления категорий импортированным транзакциям).
- Теги, отчёты, бюджеты.
- Мультивалютные переводы между счетами.
- Специфические парсеры под каждый банк (сейчас только универсальный CSV).
- Редактирование отдельной транзакции — пока только bulk-импорт + комментарий + категории + удаление батча.
- Валюты со scale ≠ 2 (JPY, KWD).
- Шифрование БД.
