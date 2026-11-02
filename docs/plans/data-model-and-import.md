# Data Model & Import Mechanism for finances-v2

## Context

Приложение — персональный менеджер финансов на Tauri 2 + React + SQLite. Сейчас это Hello-World-скаффолд ([src-tauri/src/lib.rs](src-tauri/src/lib.rs), [src/App.tsx](src/App.tsx)), единственный Tauri-command — `data_dir`, который отдаёт путь из `FINANCES_DATA_DIR`.

Нужно заложить фундамент модели данных и первые два рабочих механизма: «завести счёт» и «загрузить транзакции». Импорт должен группироваться в батчи с простым удалением и перезагрузкой — это критично на раннем этапе, пока пользователь экспериментирует с форматами выгрузок разных банков.

## Архитектурные решения

- **ORM/БД:** SQLite через `rusqlite` (bundled) + единое `Mutex<Connection>` в `tauri::State`. Rusqlite синхронный и простой; пул не нужен для одного десктоп-клиента. Миграции — вручную через массив `(version, sql)`, применяемые при старте.
- **Деньги:** `INTEGER` в минимальных единицах валюты (копейки/центы), всегда 2 знака после запятой. Конверсия `string ⇄ i64` — через `rust_decimal` в Rust и `bigint`/строки на фронте. JPY/KWD добавим позже, если понадобятся.
- **Даты:** хранить два столбца — `occurred_at_utc TEXT NOT NULL` (ISO-8601 UTC, основа для сортировки/сравнения) и `occurred_at_tz TEXT NOT NULL` (исходный offset, вида `+03:00`). Это даёт сравнение между таймзонами и сохранение «настенного» времени пользователя.
- **Импорт-батчи:** отдельная таблица `import_batches`, FK на `accounts`, `transactions.import_batch_id` с `ON DELETE CASCADE`. Удаление батча удаляет все его транзакции.
- **SQL-слой в Rust:** команды `invoke`-ируются из фронта; вся SQL — на Rust-стороне, TypeScript не знает про SQL. Даёт единое место для валидаций.
- **CSV на фронте:** парсим через `papaparse`, отправляем массив строк в Rust-команду. Rust валидирует, парсит суммы, проверяет цепочку балансов, пишет одной транзакцией.

## Схема БД ([src-tauri/migrations/001_init.sql](src-tauri/migrations/001_init.sql) — новый)

```sql
CREATE TABLE accounts (
    id             INTEGER PRIMARY KEY,
    bank           TEXT NOT NULL,
    currency       TEXT NOT NULL,            -- ISO 4217 (RUB, USD, EUR)
    account_number TEXT NOT NULL,
    owner_name     TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(bank, account_number)
);

CREATE TABLE import_batches (
    id              INTEGER PRIMARY KEY,
    account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    imported_at     TEXT NOT NULL,           -- ISO-8601 UTC (время загрузки = «айдишник» для пользователя)
    source_filename TEXT,                    -- оригинальное имя файла для UI
    row_count       INTEGER NOT NULL
);
CREATE INDEX idx_batches_account ON import_batches(account_id);

CREATE TABLE transactions (
    id               INTEGER PRIMARY KEY,
    account_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    import_batch_id  INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    occurred_at_utc  TEXT    NOT NULL,       -- ISO-8601 в UTC, для сортировки/сравнения
    occurred_at_tz   TEXT    NOT NULL,       -- '+03:00', сохраняем «настенное» время
    credit           INTEGER NOT NULL DEFAULT 0,  -- поступление, в минимальных единицах
    debit            INTEGER NOT NULL DEFAULT 0,  -- списание, в минимальных единицах
    balance          INTEGER NOT NULL,        -- баланс ПОСЛЕ транзакции, в мин. единицах
    description      TEXT    NOT NULL DEFAULT '',
    CHECK (credit >= 0),
    CHECK (debit  >= 0),
    CHECK (credit = 0 OR debit = 0)
);
CREATE INDEX idx_txn_account_time ON transactions(account_id, occurred_at_utc, id);
CREATE INDEX idx_txn_batch ON transactions(import_batch_id);
```

## Структура кода

### Rust-сторона (`src-tauri/src/`)

| Файл | Назначение |
|---|---|
| [db.rs](src-tauri/src/db.rs) — новый | `open_connection(data_dir)`: открывает `finances.db`, включает `PRAGMA foreign_keys = ON`, применяет миграции. |
| [money.rs](src-tauri/src/money.rs) — новый | `parse_minor(s: &str) -> Result<i64>` и `format_minor(n: i64) -> String`. Через `rust_decimal`. |
| [accounts.rs](src-tauri/src/accounts.rs) — новый | Структура `Account`, команды `create_account`, `list_accounts`. |
| [transactions.rs](src-tauri/src/transactions.rs) — новый | Структура `Transaction`, `TxnRow` (DTO с фронта), команды `import_transactions`, `list_transactions`, `list_import_batches`, `delete_import_batch`, `validate_balance_chain`. |
| [lib.rs](src-tauri/src/lib.rs) — правим | Открываем коннекшен в `run()`, кладём в `.manage()`, регистрируем команды. |
| [Cargo.toml](src-tauri/Cargo.toml) — правим | Добавляем `rusqlite` (с `bundled`), `rust_decimal`, `chrono` (с `serde`). |

### Фронт (`src/`)

| Файл | Назначение |
|---|---|
| [lib/api.ts](src/lib/api.ts) — новый | Типизированные обёртки над `invoke`: `createAccount`, `listAccounts`, `importTransactions`, `listTransactions`, `listImportBatches`, `deleteImportBatch`. |
| [lib/csv.ts](src/lib/csv.ts) — новый | Парсинг CSV через `papaparse` в `TxnRow[]`. |
| [pages/Accounts.tsx](src/pages/Accounts.tsx) — новый | Таблица счетов + форма «Завести счёт». |
| [pages/AccountTransactions.tsx](src/pages/AccountTransactions.tsx) — новый | Таблица транзакций по счёту + панель с батчами + кнопка «Импорт». |
| [pages/ImportDialog.tsx](src/pages/ImportDialog.tsx) — новый | Выбор файла (через `tauri-plugin-dialog`), превью строк, статус валидации цепочки балансов, кнопка «Подтвердить». |
| [App.tsx](src/App.tsx) — правим | Простой роутинг (hash-based или `react-router`): `/accounts`, `/accounts/:id`. Заменяем Hello World. |
| [package.json](package.json) — правим | Добавляем `papaparse`, `@types/papaparse`, `@tauri-apps/plugin-dialog`. |

## Механизмы

### 1. Завести счёт (`create_account`)
Форма с 4 полями → `invoke("create_account", {bank, currency, accountNumber, ownerName})` → INSERT → возвращается `Account`. Ошибка уникальности маппится в понятное сообщение.

### 2. Импорт транзакций (`import_transactions`)

**Унифицированный CSV-формат (MVP):**
```
occurred_at,credit,debit,balance,description
2026-04-01T10:15:00+03:00,,500.00,12340.50,Coffee shop
2026-04-01T18:30:00+03:00,50000.00,,62340.50,Salary
```
- `occurred_at` — ISO-8601 с offset'ом обязателен
- `credit` / `debit` — ровно одно из двух заполнено (пусто = 0)
- `balance` — после операции
- `description` — опциональное

**Флоу:**
1. Пользователь жмёт «Импорт» на странице счёта.
2. `tauri-plugin-dialog` → выбор CSV-файла.
3. `papaparse` парсит → превью в таблице.
4. Кнопка «Подтвердить» → `invoke("import_transactions", {accountId, sourceFilename, rows})`.
5. Rust в одной SQL-транзакции:
   - создаёт `import_batches` (имя файла, `imported_at = now UTC`, `row_count`);
   - парсит суммы `rust_decimal` → `i64` копейки;
   - разделяет `occurred_at` на UTC + offset;
   - INSERT-ит транзакции с `import_batch_id`;
   - прогоняет `validate_balance_chain` по всему счёту.
6. Возвращает `ImportResult { batch_id, inserted, validation_errors: Vec<ValidationError> }`.
7. Фронт показывает «успех» или список разрывов; транзакции уже в БД — ошибки информативные, не откатывают.

### 3. Валидация цепочки балансов (`validate_balance_chain`)
- Читаем все транзакции счёта, отсортированные по `(occurred_at_utc, id)`.
- Проверяем: `balance[N] == balance[N-1] + credit[N] - debit[N]`.
- Возвращаем `Vec<ValidationError { txn_id, expected_balance, actual_balance }>`.
- Для первой транзакции в счёте предыдущий баланс считаем как `balance[0] - credit[0] + debit[0]` (т.е. первый ряд всегда валиден, он задаёт стартовый баланс).

### 4. Удаление батча (`delete_import_batch`)
- `DELETE FROM import_batches WHERE id = ?` → cascade удаляет все транзакции.
- На UI — список батчей справа от таблицы транзакций: дата загрузки + имя файла + количество строк + кнопка «Удалить» с подтверждением.
- После удаления — перечитать таблицу транзакций.

### 5. Просмотр (`list_accounts`, `list_transactions`, `list_import_batches`)
- Простые SELECT-ы. Транзакции пагинируем по дате через `occurred_at_utc`.

## Зависимости

**Rust (`src-tauri/Cargo.toml`):**
```toml
rusqlite = { version = "0.32", features = ["bundled"] }
rust_decimal = "1"
chrono = { version = "0.4", features = ["serde"] }
```
Плюс плагин диалогов (подключаем с JS-стороны через `tauri-plugin-dialog`):
```toml
tauri-plugin-dialog = "2"
```

**JS (`package.json`):**
```json
"papaparse": "^5.4.1",
"@tauri-apps/plugin-dialog": "^2"
```
Плюс `@types/papaparse` в devDependencies.

**Capabilities ([src-tauri/capabilities/default.json](src-tauri/capabilities/default.json)):** добавить `"dialog:allow-open"` и `"dialog:default"`.

## Порядок реализации

1. Зависимости: `Cargo.toml` + `package.json`.
2. SQL-миграция + `db.rs` (открытие, миграция, `Mutex<Connection>` в state).
3. `money.rs` — парсинг/форматирование сумм.
4. `accounts.rs` — модель + 2 команды, плюс регистрация в `lib.rs`.
5. Фронт: `api.ts` + страница счетов с формой и таблицей → **первая end-to-end проверка** (создать счёт руками, посмотреть в списке).
6. `transactions.rs` — модель, валидация цепочки, команды импорта/листинга/удаления батча.
7. `csv.ts` + `ImportDialog.tsx` + `AccountTransactions.tsx`.
8. Роутинг в `App.tsx`.

## Верификация

- **Ручная прогонка end-to-end:**
  1. `./scripts/dev.sh` с `FINANCES_DATA_DIR=$HOME/.finances-v2-dev`.
  2. Создать счёт (банк = Сбер, валюта = RUB, номер = `40817...`, владелец).
  3. Положить рядом тест-CSV из 5 строк с корректной цепочкой балансов → импорт → убедиться, что все 5 появились, батч есть в панели.
  4. Добавить испорченный CSV (намеренный разрыв) → импорт → убедиться, что `validation_errors` показаны на UI и указывают на правильные строки.
  5. Удалить батч из UI → транзакции исчезли, счёт остался.
  6. Перезапустить приложение → данные на месте (проверка персистентности в `FINANCES_DATA_DIR/finances.db`).
- **Rust-юнит-тест** на `validate_balance_chain`:
  - Валидная последовательность → `errors.is_empty()`.
  - Последовательность с разрывом в середине → одна ошибка с правильными `expected`/`actual`.
- **Проверка SQL-целостности:** после `DELETE FROM import_batches WHERE id = ?` в `sqlite3` убедиться, что FK-каскад сработал (`SELECT COUNT(*) FROM transactions WHERE import_batch_id = ?` → 0).

## Что вынесено за рамки MVP

- Категории, теги, отчёты.
- Мультивалютные переводы между счетами.
- Специфические CSV-парсеры под банки (Сбер, Т-Банк и т.д.) — добавятся поверх универсального формата.
- Редактирование отдельной транзакции (пока только bulk-импорт и удаление батча).
- Валюты со scale ≠ 2.
- Аутентификация / шифрование БД.

## Уточнение модели дат (2026-04-27)

В ходе ревью отказались от per-row хранения offset'а. Все строки одной банковской выписки разделяют один offset — дублирование `occurred_at_tz` в каждой транзакции не давало пользы. Перенесли его на уровень `import_batches`:

- Миграция [004_move_timezone_to_import_batch.sql](src-tauri/migrations/004_move_timezone_to_import_batch.sql): добавляет `import_batches.timezone_offset`, бэкфиллит из любой транзакции батча, дропает `transactions.occurred_at_tz`.
- В `import_transactions` парсим offset из CSV (как раньше через `chrono::DateTime::parse_from_rfc3339`), валидируем что **все строки** одной партии имеют одинаковый offset (иначе ошибка импорта), сохраняем единственное значение на батче.
- UI: убрана колонка `TZ` из таблицы транзакций, offset показывается в панели «Загрузки» рядом с количеством строк.

Trade-off: если выписка пересекает переход на летнее время — offset для части строк станет немного некорректным. Для личных финансов это терпимо (и большинство банков выгружают уже нормализованные данные). Если в будущем понадобится импорт из источников со смешанными offset'ами — либо бить на батчи, либо вернуть поле обратно в транзакцию.

## Итог реализации (2026-04-24)

Всё сделано по плану, с одним упрощением: отказались от `tauri-plugin-dialog` + `tauri-plugin-fs` в пользу стандартного `<input type="file">`. На macOS он открывает нативный OS-диалог через WKWebView (UX идентичен), а `File.text()` читает содержимое без отдельной FS-плагин-пермиссии. Это убрало две зависимости и одну capability-запись — меньше поверхности в MVP.

Ключевые артефакты:
- Rust-модули: [db.rs](src-tauri/src/db.rs), [money.rs](src-tauri/src/money.rs), [accounts.rs](src-tauri/src/accounts.rs), [transactions.rs](src-tauri/src/transactions.rs).
- Миграция: [migrations/001_init.sql](src-tauri/migrations/001_init.sql).
- Фронт: [pages/Accounts.tsx](src/pages/Accounts.tsx), [pages/AccountTransactions.tsx](src/pages/AccountTransactions.tsx), [pages/ImportDialog.tsx](src/pages/ImportDialog.tsx), [lib/api.ts](src/lib/api.ts), [lib/csv.ts](src/lib/csv.ts).
- Роутинг — локальный `useState` в [App.tsx](src/App.tsx) (react-router не брали, двух представлений достаточно).
- Тесты: 14 unit-тестов (`cargo test --lib`) — money parsing, balance-chain validator, миграции, FK-каскад, CHECK-constraint.
- Примеры для ручной проверки: [samples/valid-5-rows.csv](samples/valid-5-rows.csv) (валидная цепочка), [samples/invalid-balance-gap.csv](samples/invalid-balance-gap.csv) (намеренный разрыв в середине).
- Smoke test `tauri dev`: приложение поднимается, миграции применяются, `finances.db` создаётся со всеми таблицами и индексами.
