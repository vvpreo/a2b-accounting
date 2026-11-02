# Plan: табовая навигация + multi-select фильтр транзакций + i18n

## Context

Сейчас приложение использует state-based роутинг между двумя «экранами»: список счетов ([src/pages/Accounts.tsx](src/pages/Accounts.tsx)) и страница транзакций одного счёта ([src/pages/AccountTransactions.tsx](src/pages/AccountTransactions.tsx)). Переход — через callback `onSelectAccount(id)` → меняется `View` в [src/App.tsx](src/App.tsx). Все строки UI захардкожены по-русски в JSX.

Эта структура не масштабируется на следующие фичи (Категории, Настройки) и не позволяет смотреть транзакции сразу по нескольким счетам. Нужно перейти на полноценную табовую навигацию: 4 вкладки (Категории, Счета, Транзакции, Настройки), у каждой — своё «меню управления» внутри. Настройки — всегда крайняя справа. Кнопка «Транзакции →» у строки счёта переключает на вкладку Транзакции и выставляет multi-select фильтр по этому счёту.

Параллельно вводим i18n: интерфейс должен поддерживать русский (по умолчанию) и английский, с архитектурной возможностью добавлять новые языки через JSON-файлы. Выбор языка хранится в БД (как и все будущие настройки) и переключается на вкладке Настройки.

Категории — заглушка «TBD». Настройки — становятся первой работающей секцией с селектором языка.

Решения, согласованные с пользователем:
- **Импорт CSV** живёт на вкладке Счета как кнопка в actions-cell у каждой строки счёта.
- **Multi-select фильтр** — чипы-теги в верхней панели вкладки Транзакции.
- **Панель «Загрузки»** + валидация цепочки балансов — на отдельном sub-view деталей счёта внутри вкладки Счета.
- **Все настройки хранятся в БД**, не в localStorage / json-файле рядом.
- **Языки**: ru + en на старте, новые языки добавляются через JSON-файл в реестре (без UI для рантайм-добавления).

## Архитектурное решение

### Навигация (state в [src/App.tsx](src/App.tsx))

```ts
type Tab = "categories" | "accounts" | "transactions" | "settings";

const [tab, setTab] = useState<Tab>("accounts");
const [txnFilterAccountIds, setTxnFilterAccountIds] = useState<number[]>([]);
```

`txnFilterAccountIds` живёт в App, чтобы переход «Транзакции →» из строки счёта мог одновременно сменить вкладку и выставить фильтр. Пустой массив = «все счета» (никакого фильтра).

### Структура tab-bar

```
[Категории] [Счета] [Транзакции]                              [Настройки]
                                                              ^^^^^^^^^^
                                                              margin-left: auto
```

`Настройки` всегда крайняя справа (CSS `justify-content: space-between` через две flex-группы или `margin-left: auto` на последней кнопке).

### Структура вкладки

```
┌──────────────────────────────────────────────────┐
│ [Tab 1] [Tab 2] [Tab 3]              [Settings]  │  ← tab bar
├──────────────────────────────────────────────────┤
│ <Меню управления вкладкой>                       │  ← per-tab toolbar
├──────────────────────────────────────────────────┤
│ <Содержимое вкладки>                             │
└──────────────────────────────────────────────────┘
```

Меню управления:
- **Счета**: форма «Завести счёт» (как сейчас).
- **Транзакции**: чипы-фильтр по счетам.
- **Категории**: TBD-заглушка.
- **Настройки**: рабочая секция «Язык интерфейса» (селектор + сохранение в БД).

### Sub-view деталей счёта (внутри вкладки Счета)

Вкладка Счета имеет два состояния:
1. **Список** (по умолчанию) — таблица счетов + форма создания.
2. **Детали счёта** — открывается по клику на «Подробнее» в actions-cell. Показывает метаданные счёта, панель «Загрузки» (батчи импорта), валидацию цепочки балансов, кнопку «Назад к списку», кнопку «Изменить» (открывает существующий `EditAccountModal`).

Это sub-state внутри `AccountsTab`, не отдельная вкладка. Управляется локальным `useState<number | null>(detailAccountId)`.

### Actions-cell у строки счёта

В таблице счетов колонка «Действия» получает три кнопки:
1. **Транзакции →** — переключает вкладку: `setTab("transactions"); setTxnFilterAccountIds([account.id])`.
2. **Импорт CSV** — открывает существующий `ImportDialog` для этого счёта.
3. **Подробнее** — переключает на sub-view деталей внутри вкладки.

Кнопка «Изменить» уезжает на sub-view деталей (редактирование/удаление счёта — редкая операция, ок убрать из главного списка).

### Бэкенд: `list_transactions` принимает фильтр

Сейчас `list_transactions(account_id: i64)` ([src-tauri/src/transactions.rs:227](src-tauri/src/transactions.rs#L227)) жёстко требует один счёт. Расширяем:

```rust
#[tauri::command]
pub fn list_transactions(
    state: State<'_, DbState>,
    account_ids: Option<Vec<i64>>,
) -> Result<Vec<Transaction>, String>
```

- `None` или пустой Vec → все транзакции (без WHERE).
- Непустой Vec → `WHERE account_id IN (?, ?, ...)` через построение плейсхолдеров.
- Сортировка та же: `ORDER BY occurred_at_utc ASC, id ASC`.

`list_import_batches`, `validate_balance_chain`, `import_transactions` остаются как есть — они работают только в контексте одного счёта (sub-view деталей).

### Бэкенд: `app_settings` для всех настроек

Новая миграция `005_add_app_settings.sql`:

```sql
CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

Новый модуль `src-tauri/src/settings.rs` с двумя tauri-командами:

```rust
#[tauri::command]
pub fn get_setting(state: State<'_, DbState>, key: String) -> Result<Option<String>, String>;

#[tauri::command]
pub fn set_setting(state: State<'_, DbState>, key: String, value: String) -> Result<(), String>;
```

`set_setting` использует `INSERT ... ON CONFLICT (key) DO UPDATE SET value = excluded.value` (UPSERT). Регистрируется в [src-tauri/src/lib.rs](src-tauri/src/lib.rs) рядом с остальными командами.

Ключ для языка: `"locale"`. Это единственный ключ для текущей задачи; в будущем сюда же лягут темы, форматы дат и т.д.

### Фронтенд: i18n инфраструктура

Минимальное решение через React Context (без `react-i18next` — для текущего объёма строк лишняя зависимость).

**Структура:**

```
src/i18n/
├── index.ts              реестр языков, Context, Provider, хук useT
├── locales/
│   ├── ru.json           русский
│   └── en.json           английский (fallback default)
```

**Реестр языков** в `src/i18n/index.ts`:

```ts
import ru from "./locales/ru.json";
import en from "./locales/en.json";

export const LANGUAGES = [
  { code: "ru", name: "Русский", messages: ru },
  { code: "en", name: "English", messages: en },
] as const;

export type LocaleCode = typeof LANGUAGES[number]["code"];
```

Добавить новый язык = создать `xx.json` + добавить запись в `LANGUAGES`. Никаких других изменений не требуется.

**Context + хук:**

```ts
const I18nContext = createContext<{
  locale: LocaleCode;
  setLocale: (code: LocaleCode) => Promise<void>;
  t: (key: string) => string;
}>(...);

export function useT() {
  const { t } = useContext(I18nContext);
  return t;
}

export function useI18n() {
  return useContext(I18nContext);
}
```

`t(key)` — простой lookup по dot-path в JSON (`"accounts.title"` → `messages.accounts.title`). Если ключ не найден — возвращаем сам ключ + console.warn (помогает заметить пропущенные строки в dev). Без интерполяции/плюрализации в первой версии: если по ходу обнаружим необходимость (например, «5 строк / 1 строка»), добавим простую `t(key, params)`.

**Provider:**

```tsx
<I18nProvider initialLocale={loaded}>
  <App />
</I18nProvider>
```

Initial-locale загружается в `src/main.tsx` через `getSetting("locale")` ДО рендера. Если в БД ничего нет или язык неизвестный — определяем системный через `navigator.language`: начинается с `"ru"` → `"ru"`, иначе → `"en"`. То есть default = системный язык с fallback на английский. Смена через `setLocale("en")` обновляет state и зовёт `setSetting("locale", "en")`.

**Перевод существующих строк:**

В JSON-файлах ключи группируются по экранам:

```json
{
  "common": { "cancel": "Отмена", "save": "Сохранить", ... },
  "tabs": { "categories": "Категории", "accounts": "Счета", "transactions": "Транзакции", "settings": "Настройки" },
  "accounts": { "title": "Счета", "createButton": "Завести счёт", ... },
  "transactions": { ... },
  "import": { ... },
  "settings": { "language": "Язык интерфейса", ... }
}
```

Все захардкоженные строки в текущих компонентах ([Accounts.tsx](src/pages/Accounts.tsx), [AccountTransactions.tsx](src/pages/AccountTransactions.tsx), [ImportDialog.tsx](src/pages/ImportDialog.tsx), [App.tsx](src/App.tsx)) заменяются на `t("...")`. Имена банков и валютные коды — не трогаем (это идентификаторы).

### Настройки: селектор языка

Компонент `Settings.tsx`:

```tsx
<section className="page">
  <h2>{t("settings.title")}</h2>

  <div className="settings-row">
    <label>{t("settings.language")}</label>
    <select value={locale} onChange={(e) => setLocale(e.target.value as LocaleCode)}>
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>{l.name}</option>
      ))}
    </select>
  </div>
</section>
```

При смене сразу же:
1. `setLocale` обновляет Context (вся UI перерисовывается со строками нового языка).
2. `setSetting("locale", code)` уходит на бэкенд.

## Изменения по файлам

### Новые файлы

| Файл | Назначение |
|---|---|
| `src/pages/Transactions.tsx` | Вкладка «Транзакции». Чипы-фильтр + общая таблица транзакций. Принимает props `accountIds: number[]`, `onChangeAccountIds: (ids: number[]) => void`. |
| `src/pages/Categories.tsx` | Заглушка с текстом «TBD». |
| `src/pages/Settings.tsx` | Рабочая страница с селектором языка. |
| `src/components/Tabs.tsx` | Навигационный компонент: принимает `tab`, `onChange`, рендерит 4 кнопки с правильным расположением (Настройки справа). |
| `src/components/AccountChips.tsx` | Multi-select чипов: чип «Все» (clear filter) + чип на каждый счёт. Кликабельны, активные подсвечены. Используется только на вкладке Транзакции. |
| `src/i18n/index.ts` | Реестр языков (`LANGUAGES`), Context, Provider, хук `useT()` / `useI18n()`. |
| `src/i18n/locales/ru.json` | Русские переводы. |
| `src/i18n/locales/en.json` | Английские переводы. |
| `src-tauri/migrations/005_add_app_settings.sql` | Таблица `app_settings (key, value)`. |
| `src-tauri/src/settings.rs` | Команды `get_setting`, `set_setting`. |

### Изменяемые файлы

| Файл | Изменение |
|---|---|
| [src/App.tsx](src/App.tsx) | Переход с `View` discriminated union на `tab: Tab` + `txnFilterAccountIds: number[]`. Рендерит `<Tabs>` сверху и одну из 4 страниц по `tab`. Передаёт фильтр в `<TransactionsPage>`. Все строки через `t()`. |
| [src/main.tsx](src/main.tsx) | Перед рендером `<App />` загружает `getSetting("locale")` (с fallback на `"ru"`), оборачивает приложение в `<I18nProvider initialLocale={...}>`. |
| [src/pages/Accounts.tsx](src/pages/Accounts.tsx) | Убрать `onSelectAccount`. Добавить sub-state `detailAccountId`. В actions-cell — три кнопки (Транзакции / Импорт / Подробнее). Принять props `onGoToTransactions: (accountIds: number[]) => void`. При `detailAccountId !== null` рендерится sub-view с метаданными счёта, валидацией и панелью «Загрузки». Все строки через `t()`. |
| [src/pages/ImportDialog.tsx](src/pages/ImportDialog.tsx) | Все строки через `t()`. Логика не меняется. |
| [src/lib/api.ts](src/lib/api.ts) | `listTransactions(accountIds?: number[])` принимает опциональный массив. Добавить `getSetting(key: string): Promise<string \| null>` и `setSetting(key: string, value: string): Promise<void>`. |
| [src-tauri/src/transactions.rs](src-tauri/src/transactions.rs) | `list_transactions` принимает `account_ids: Option<Vec<i64>>`. SQL динамически строит `IN (?, ?, ...)` из плейсхолдеров. |
| [src-tauri/src/db.rs](src-tauri/src/db.rs) | Зарегистрировать миграцию `005_add_app_settings`. |
| [src-tauri/src/lib.rs](src-tauri/src/lib.rs) | Добавить `mod settings;` и зарегистрировать `settings::get_setting`, `settings::set_setting` в `invoke_handler!`. |
| [src/App.css](src/App.css) | Добавить стили для `.tabs`, `.tab-button`, `.tab-button.active`, `.account-chips`, `.chip`, `.chip.active`, `.tab-toolbar`, `.settings-row`. Учесть dark mode. |

### Удаляемые файлы

| Файл | Причина |
|---|---|
| [src/pages/AccountTransactions.tsx](src/pages/AccountTransactions.tsx) | Распадается: общую таблицу транзакций реализует `Transactions.tsx` (вкладка), панель «Загрузки» + валидация переезжают в sub-view деталей счёта в `Accounts.tsx`. `ImportDialog` остаётся как есть и теперь триггерится из actions-cell у строки счёта. |

## Детали реализации

### Бэкенд: SQL для опционального фильтра

```rust
let (where_clause, ids): (String, Vec<i64>) = match account_ids {
    Some(ids) if !ids.is_empty() => {
        let placeholders = std::iter::repeat("?").take(ids.len()).collect::<Vec<_>>().join(",");
        (format!("WHERE account_id IN ({placeholders})"), ids)
    }
    _ => (String::new(), Vec::new()),
};
let sql = format!(
    "SELECT {TXN_COLUMNS} FROM transactions {where_clause} ORDER BY occurred_at_utc ASC, id ASC"
);
let params = rusqlite::params_from_iter(ids.iter());
```

В тестах добавить unit-тест на новую сигнатуру: пустой фильтр → все, единственный id → как раньше, несколько id → транзакции из всех указанных счетов.

### Фронтенд: чипы-фильтр (`AccountChips`)

Принимает: `accounts: Account[]`, `selected: number[]`, `onChange: (ids: number[]) => void`.

Рендерит:
- Чип «Все» — активен когда `selected.length === 0`. Клик → `onChange([])`.
- По чипу на каждый счёт — `[Сбер RUB]`. Клик переключает наличие id в массиве. Активные подсвечены (`.chip.active`).

Пустой `selected` означает «все счета», не «никакие» — это согласуется с UX «всегда что-то показано».

### Колонка «Счёт» в таблице транзакций

В таблице на вкладке Транзакции добавить первую колонку «Счёт» (имя/банк), потому что строки могут быть из разных счетов. На sub-view одного счёта (если бы был, но мы его убрали) колонка была бы избыточной.

Получаем `accounts` через `listAccounts()` параллельно с `listTransactions()`, мапим `accountId → name` для рендера.

### Sub-view деталей счёта

Локальный компонент в [src/pages/Accounts.tsx](src/pages/Accounts.tsx) (или вынести в `AccountDetail.tsx` если файл разрастётся):

```
┌───────────────────────────────────────────┐
│ ← Назад к списку счетов                   │
│ Сбер RUB · 40817... · Иван Петров         │
│                          [Изменить] [→ Транзакции]│
├───────────────────────────────────────────┤
│ Цепочка балансов: ✓ целостна              │
│ (или предупреждение с разрывами)          │
├───────────────────────────────────────────┤
│ Загрузки                                  │
│  • 2026-04-25 10:30 · invoice.csv · 5 строк · TZ +03:00  [Удалить] │
│  • ...                                    │
└───────────────────────────────────────────┘
```

Использует существующие API: `listImportBatches(accountId)`, `validateBalanceChain(accountId)`, `deleteImportBatch(batchId)`. Кнопка «Изменить» открывает существующий `EditAccountModal`. Кнопка «→ Транзакции» вызывает тот же callback `onGoToTransactions([accountId])`.

### Заглушка Категории

```tsx
export function CategoriesPage() {
  const t = useT();
  return (
    <section className="page">
      <h2>{t("categories.title")}</h2>
      <p>{t("categories.tbd")}</p>
    </section>
  );
}
```

## Порядок реализации

1. **Бэкенд i18n-фундамента**: миграция 005 + `settings.rs` + регистрация в `lib.rs`. Убедиться, что `get_setting` возвращает `None` для несуществующего ключа.
2. **Фронтенд i18n-инфраструктура**: `src/i18n/index.ts` + два JSON-файла + Provider в `main.tsx`. Параллельно — добавить `getSetting`/`setSetting` в `api.ts`.
3. **Бэкенд `list_transactions` с фильтром**: правка `transactions.rs` + новый unit-тест.
4. **Tab-навигация**: `Tabs.tsx` + рефактор `App.tsx` на 4 вкладки. Заглушки `Categories.tsx` и `Settings.tsx` (последний уже с рабочим селектором — потому что инфраструктура готова на шаге 2).
5. **Вкладка Транзакции**: `AccountChips.tsx` + `Transactions.tsx`. Получает фильтр и accounts, рисует таблицу с колонкой «Счёт».
6. **Рефакторинг Accounts**: actions-cell с тремя кнопками + sub-view деталей счёта (метаданные + Загрузки + валидация). `AccountTransactions.tsx` удаляется, его логика распределяется между `Transactions.tsx` и sub-view.
7. **Перевод всех строк**: пройтись по всем компонентам, заменить русские литералы на `t("...")`. Заполнить ru.json и en.json.
8. **Стили**: дописать `.tabs`, `.chip`, `.settings-row` и т.д. в `App.css`, не забыть dark mode.

## Верификация

1. **`cargo test --lib`** в `src-tauri/`:
   - Существующие 14 тестов должны пройти.
   - Новые тесты: `list_transactions` с фильтром (пустой / 1 id / несколько id), `get_setting`/`set_setting` (отсутствующий ключ → None, set затем get → Some(value), повторный set → обновлённое значение).
2. **`npx tsc --noEmit`** в корне — без ошибок типов. JSON-файлы импортируются с typed schema (через TS resolveJsonModule, который уже включён по умолчанию в Vite).
3. **Lint переводов**: ручная проверка что все ключи, используемые через `t()`, существуют в обоих JSON-файлах. (В будущем можно автоматизировать unit-тестом, но сейчас не обязательно — `t()` логирует warning при miss).
4. **Ручной end-to-end** через `./scripts/dev.sh`:
   - Запуск: вкладка «Счета» по умолчанию, интерфейс на русском.
   - Перейти в «Настройки» (крайняя справа) → выбрать English → весь интерфейс мгновенно переключается на английский.
   - Перезапустить приложение → язык остаётся английский (загрузился из `app_settings`).
   - Вернуть Russian → проверить что все вкладки и страницы переведены.
   - На вкладке «Счета»: создать счёт → виден в списке.
   - actions-cell строки: «Подробнее» → sub-view с инфой и пустыми «Загрузками».
   - Кнопка «Импорт CSV» → импортируем `samples/valid-5-rows.csv` → возврат в список.
   - «Подробнее» → виден батч, цепочка балансов целостна.
   - «→ Транзакции» из actions-cell → вкладка Транзакции, активен только этот счёт в чипах, в таблице 5 строк.
   - «Все» в чипах → таблица показывает транзакции всех счетов с колонкой «Счёт».
   - Создать второй счёт, импортировать → на вкладке Транзакции при «Все» обе пачки в одной таблице.
   - Удалить батч из «Подробнее» → каскадно исчезли транзакции в общей таблице.

## Out of scope

- Контент Категорий — только заглушка «TBD» (схема БД и API для категорий — отдельной задачей).
- Прочие настройки (тема, формат дат, валюта по умолчанию) — каркас `app_settings` готов, но конкретные настройки добавляем по мере необходимости.
- Плюрализация и интерполяция в i18n (если по ходу разработки обнаружится нужда — добавим простую `t(key, params)`).
- Авто-определение языка по системной локали — есть (через `navigator.language`); если язык не ru/en — fallback на en.
- Сортировка / поиск / пагинация на вкладке Транзакции.
- Подсветка валидных/невалидных строк в общей таблице (живёт только на sub-view деталей счёта).
- Сохранение выбранного фильтра между сессиями (после релоада сбрасывается).
- UI для рантайм-добавления языков. Новый язык = новый JSON-файл + запись в `LANGUAGES`.
