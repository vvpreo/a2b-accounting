# План: Конструктор отчётов

## Goal

Дать пользователю собирать произвольные P&L-отчёты по своим финансам:
- выбирать подмножество счетов;
- задавать структуру категорий (свой набор и порядок) для доходов и для расходов;
- управлять валютой, периодом и дискретностью (год/квартал/месяц);
- сохранять «представление отчёта» с именем — оно становится отдельной вкладкой в левой группе навигации.

## Context

Сейчас приложение умеет вести счета, импортировать транзакции (см. [data-model-and-import.md](data-model-and-import.md)) и распределять каждую транзакцию по одной или нескольким категориям с долями (см. [transaction-categorization.md](transaction-categorization.md)). Категории организованы в иерархию до трёх уровней с `kind ∈ {income, expense}` ([categories.rs](../../src-tauri/src/categories.rs)). Отчётов нет — это первая фича, которая «потребляет» накопленную модель данных и впервые вводит мультивалютность.

## Decisions (зафиксировано в обсуждении)

- **Навигация:** «Конструктор отчётов» — в правой группе вкладок (рядом с Категориями и Настройками); каждый сохранённый отчёт — отдельная вкладка в левой группе после «Транзакций».
- **Мультивалюта:** новая таблица `exchange_rates` + базовая валюта приложения в `app_settings.base_currency`. При агрегации каждая транзакция переводится по **ближайшему** курсу на её дату (LIMIT 1 по `rate_date <= txn_date`, fallback — ближайший в будущем).
- **Состав отчёта:** один отчёт включает обе секции (доходы и расходы) с независимыми наборами категорий.
- **Вид:** только pivot-таблица (категории × периоды + колонка «Итого» и итоговые строки по секциям). Графики — отдельной задачей в будущем.
- **«Прочее»:** не делаем. Невыбранные подкатегории молча агрегируются в выбранного предка. Если в конструкторе выбраны и предок, и потомок — вклад транзакции, привязанной к потомку, идёт в **потомка** (как наиболее специфичный); транзакции, привязанные напрямую к предку, идут в предка.
- **Без категории:** отдельной строкой в каждой секции по флагу `showUncategorized` в представлении. Источник — нераспределённый остаток `total_minor − Σ shares`, как в существующей логике пикера категорий.
- **Корректирующие транзакции** (`is_correcting = true`) пропускаются — они синтетические.
- **Что фиксирует представление:** имя, счета, валюта базы конвертации, структура категорий (списки выбранных id с порядком), флаг `showUncategorized`, **дефолтный** период и дискретность. Период/дискретность/валюта — изменяемые на экране отчёта runtime-контролы.
- **Упорядочивание категорий в конструкторе:** стрелки `↑/↓` (DnD не тащим — лишняя зависимость, отложено).

## Steps

Реализация разбита на 3 самостоятельных PR — каждый этап осмыслен сам по себе.

### Этап 1 — Курсы и базовая валюта

**Файлы:**
- создать `src-tauri/migrations/010_add_exchange_rates.sql`
- создать `src-tauri/src/exchange_rates.rs`
- зарегистрировать миграцию в [src-tauri/src/db.rs](../../src-tauri/src/db.rs) (массив `MIGRATIONS`)
- зарегистрировать команды в [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs)
- расширить [src/pages/Settings.tsx](../../src/pages/Settings.tsx) (базовая валюта + редактор курсов)
- добавить обёртки в [src/lib/api.ts](../../src/lib/api.ts)
- добавить ключи в [src/i18n/locales/ru.json](../../src/i18n/locales/ru.json) и [src/i18n/locales/en.json](../../src/i18n/locales/en.json)

**Миграция 010:**
```sql
CREATE TABLE exchange_rates (
    id            INTEGER PRIMARY KEY,
    currency      TEXT NOT NULL,        -- ISO-код, например "USD"
    rate_date     TEXT NOT NULL,        -- 'YYYY-MM-DD' (локальная дата котировки)
    rate_to_base  TEXT NOT NULL,        -- Decimal-строка: сколько base-валюты за 1 unit currency
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(currency, rate_date)
);
CREATE INDEX idx_rates_lookup ON exchange_rates(currency, rate_date);
```

Базовая валюта — ключ `base_currency` в существующей `app_settings`. Если ключа нет — UI просит выбрать (по умолчанию предлагаем валюту первого созданного счёта).

**Backend модуль `exchange_rates.rs`:**
- `pub struct ExchangeRate { id, currency, rate_date, rate_to_base }` (Decimal сериализуется как строка по аналогии с [money.rs](../../src-tauri/src/money.rs)).
- Tauri-команды: `list_exchange_rates`, `upsert_exchange_rate(currency, rate_date, rate_to_base)`, `delete_exchange_rate(id)`.
- Внутренняя `pub(crate) fn rate_at(conn, currency, date_utc, base_currency) -> Result<Decimal>`:
  - если `currency == base_currency` → `1`;
  - SQL `SELECT rate_to_base FROM exchange_rates WHERE currency = ? AND rate_date <= ? ORDER BY rate_date DESC LIMIT 1`;
  - если ничего не найдено — пробуем ближайший в будущем (`>= ?`);
  - если совсем пусто — `Err(MissingRate { currency, date })`.

**Settings UI:**
- селект «Базовая валюта» (использует `currencies.ts`, читает/пишет `app_settings.base_currency`);
- блок «Курсы валют» — таблица `(currency, rate_date, rate_to_base)` с inline-добавлением и удалением. Базовая валюта в этой таблице не редактируется (всегда `1`).

**Тесты (`cargo test --lib`):**
- точный курс на дату; ближайший до; ближайший после; пустая таблица → `MissingRate`; `currency == base` → `1`; UNIQUE по `(currency, rate_date)`.

### Этап 2 — Сохраняемые представления + пустой конструктор

**Файлы:**
- создать `src-tauri/migrations/011_add_report_views.sql`
- создать `src-tauri/src/report_views.rs`
- создать `src/pages/ReportsBuilder.tsx`
- зарегистрировать миграцию и команды
- расширить [src/components/Tabs.tsx](../../src/components/Tabs.tsx): новый тип `Tab` + динамические табы отчётов
- расширить [src/App.tsx](../../src/App.tsx): хранение `reportViews`, рендер `<ReportsBuilderPage>` и заглушки для `report-id` вкладки
- добавить обёртки в [src/lib/api.ts](../../src/lib/api.ts)
- ключи i18n

**Миграция 011:**
```sql
CREATE TABLE report_views (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    config      TEXT NOT NULL,        -- JSON, версионированный
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_report_views_sort ON report_views(sort_order, id);
```

**Структура `config`** (TS-сторона валидирует, Rust хранит как непрозрачный текст):
```jsonc
{
  "version": 1,
  "accountIds": [1, 2],
  "expenseCategoryIds": [3, 5, 8],     // порядок = порядок в отчёте
  "incomeCategoryIds": [12],
  "showUncategorized": true,
  "defaultRange": {
    "kind": "preset",                   // "preset" | "custom"
    "preset": "current_year",           // current_month | current_quarter | current_year | last_12_months | all_time
    "from": null, "to": null            // используются при kind = "custom" (YYYY-MM-DD)
  },
  "defaultGranularity": "month",        // year | quarter | month
  "defaultCurrency": "RUB",             // валюта отображения по умолчанию
  "expandedCategoryIds": []             // initial fold/unfold состояние строк pivot
}
```

**Backend модуль `report_views.rs`:**
- `pub struct ReportView { id, name, config, sort_order, created_at, updated_at }`.
- Команды: `list_report_views`, `create_report_view(name, config)`, `update_report_view(id, name, config)`, `delete_report_view(id)`, `reorder_report_views(ids)`.
- Валидация: `config` — sanity check парсингом `serde_json::Value`. Уникальность `name` — на уровне SQL.

**Frontend — новый тип навигации:**
```ts
export type StaticTab = "accounts" | "transactions" | "categories" | "reports_builder" | "settings";
export type Tab = StaticTab | { kind: "report"; id: number };
```
[Tabs.tsx](../../src/components/Tabs.tsx) принимает `reportViews: ReportView[]` и рендерит динамические табы в левой группе после «Транзакций». [App.tsx](../../src/App.tsx) держит список view, обновляет его по событию `refreshReportViews`.

**`ReportsBuilder.tsx` (страница в правой группе):**
1. Поле «Название».
2. Multi-select счетов (использует существующий [MultiSelectDropdown.tsx](../../src/components/MultiSelectDropdown.tsx)).
3. Две секции — «Доходы» и «Расходы». В каждой:
   - дерево категорий (через [category-tree.ts](../../src/lib/category-tree.ts) как в [Categories.tsx](../../src/pages/Categories.tsx)) с чекбоксами;
   - стрелки `↑/↓` рядом с выбранными категориями для упорядочивания.
4. Чекбокс «Показывать Без категории».
5. Блок «Дефолты»: пресет периода (+ инпуты дат при `custom`); селект дискретности; селект валюты.
6. Кнопки «Сохранить» / «Отмена», в режиме редактирования — «Удалить» (inline-confirm как в Categories).

На вкладке `{ kind: "report", id }` пока заглушка «Отчёт ещё не реализован» + кнопка «Редактировать» — фактически готовый каркас навигации.

**Тесты:**
- `report_views`: CRUD, уникальность `name`, отказ при невалидном JSON.

### Этап 3 — Движок отчёта и pivot

**Файлы:**
- создать `src-tauri/src/reports.rs`
- создать `src/pages/ReportView.tsx`
- зарегистрировать команду
- стили pivot в [src/App.css](../../src/App.css)
- ключи i18n
- обновить [README.md](../../README.md): новая таблица + страницы в разделе Architecture

**Backend модуль `reports.rs`:**
- `pub struct ReportRequest { account_ids, expense_category_ids, income_category_ids, show_uncategorized, from, to, granularity, target_currency }` (даты — `YYYY-MM-DD` локально).
- `pub struct ReportResponse { periods: Vec<PeriodColumn>, expense: SectionData, income: SectionData }`.
- `pub struct SectionData { rows: Vec<ReportRow>, total: Vec<String> }`.
- `pub struct ReportRow { category_id: Option<i64>, name, color, depth, values: Vec<String>, total: String }`.
- Команда `compute_report(req) -> ReportResponse`.

**Алгоритм `compute_report`:**
1. Достать `base_currency` из `app_settings`. Если не задана — `Err`.
2. Расширить `expense_category_ids` и `income_category_ids` транзитивно потомками. Для каждой категории определить **representative ancestor** — выбранную категорию, в которую сворачивается вклад. Если потомок не выбран — сворачивается в ближайшего выбранного предка. Если выбраны и предок и потомок — вклад транзакции, привязанной к потомку, идёт в потомка; транзакции, привязанные напрямую к предку, идут в предка.
3. Загрузить транзакции выбранных счетов в окне `[from, to]`. Для каждой транзакции — её `transaction_categories` через существующий `list_categories_internal` в [transaction_categories.rs](../../src-tauri/src/transaction_categories.rs).
4. Для каждой строки `(transaction, category, share_minor)`:
   - определить целевую `representative` категорию по правилам п.2; если её нет в выбранном множестве — пропустить;
   - конвертировать `share_minor` из валюты счёта в `target_currency` через `rate_at(account.currency, txn.date, base) / rate_at(target_currency, txn.date, base)`;
   - распределить в нужный `period` (по `occurred_at_utc` + локальная таймзона импорт-батча) и в нужную секцию (income/expense по знаку).
5. Если `show_uncategorized = true`: для каждой транзакции остаток `total_minor − Σ shares` идёт в виртуальную строку «Без категории» (отдельно для income и expense по знаку).
6. Корректирующие транзакции (`is_correcting`) — пропускаем.
7. Сложить `total` по строкам и колонкам.

**`ReportView.tsx` (вкладка сохранённого отчёта):**
- шапка с runtime-контролами (период, дискретность, валюта — инициализируются из `defaultRange/defaultGranularity/defaultCurrency`);
- pivot-таблица:
  ```
                    2026-Q1   2026-Q2   Итого
  Доходы
    Зарплата          …          …       …
    Итого доходов     …          …       …
  Расходы
    Еда               …          …       …
      ▾ Кафе          …          …       …
      ▾ Магазины      …          …       …
    Транспорт         …          …       …
    Без категории     …          …       …
    Итого расходов    …          …       …
  ```
- fold/unfold (`▸/▾`) для строк с подкатегориями; начальное состояние из `expandedCategoryIds`;
- кнопка «Редактировать» → `ReportsBuilder` с этим view.

**Тесты `reports`:**
- один счёт, одна валюта, одна категория, период = месяц → ожидаемая агрегация;
- родитель + потомок, оба выбраны → транзакция на потомке учитывается на потомке, транзакция на предке — на предке;
- потомок не выбран → его сумма уходит в выбранного предка;
- смешанные валюты: счёт USD, base=RUB, target=RUB, курс USD→RUB на дату → корректная конвертация;
- `show_uncategorized=true` → нераспределённый остаток виден отдельной строкой;
- корректирующие транзакции игнорируются.

## Verification

После каждого этапа:
- `cd src-tauri && cargo test --lib` — все новые тесты зелёные, существующие 55 не сломаны;
- `npm run build` — tsc-проверка проходит;
- `./scripts/dev.sh` — ручная проверка соответствующего куска UI.

End-to-end сценарий после Этапа 3:
1. В Настройках выбрать `RUB` базовой валютой и завести 2-3 курса USD→RUB на разные даты.
2. На существующих счетах создать категорию «Еда» с подкатегориями «Кафе», «Магазины»; распределить пару транзакций.
3. Открыть «Конструктор отчётов», создать представление «Бюджет 2026»: оба счёта (RUB+USD), Расходы → Еда+Кафе, Доходы → пусто, валюта RUB, дискретность месяц.
4. Убедиться, что слева появилась вкладка «Бюджет 2026».
5. Перейти на неё, поменять период/валюту/дискретность runtime, свернуть/развернуть «Еда», убедиться в корректности сумм (особенно конвертации USD-транзакций).
6. Пересоздать представление с `showUncategorized=true` — нераспределённый остаток должен попасть в отдельную строку.

## Открытые вопросы (вне MVP)

- DnD упорядочивания категорий (сейчас стрелки `↑↓`).
- Графики поверх pivot.
- Импорт курсов из CSV.
- Если сохранённых отчётов 20+ и левая навигация не вмещает — горизонтальный скролл или выпадающее меню. Решим, когда станет проблемой.
