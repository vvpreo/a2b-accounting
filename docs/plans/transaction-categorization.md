# План: привязка категорий к транзакциям

## Goal

Дать пользователю возможность отнести каждую транзакцию к одной или нескольким категориям с указанием доли каждой категории в сумме транзакции (через каскадные слайдеры).

## Context

Справочник категорий уже реализован (`/categories`, миграция 008). В таблице транзакций колонка «Категория» зарезервирована, но всегда отображает прочерк ([Transactions.tsx:379](../../src/pages/Transactions.tsx#L379)). Нужен слой привязки `transaction ↔ category` с долями в копейках, инлайновый виджет в ячейке для быстрых действий и полная модалка для тонкой настройки распределения. Это закрывает последний MVP-пункт из «не вошло в MVP» в [README.md](../../README.md).

## Decisions (зафиксировано в обсуждении)

- Сцепка `kind` строгая: `credit > 0` ↔ категории `kind = "income"`, `debit > 0` ↔ `expense`.
- Корректирующие транзакции (`is_correcting = true`) категоризируются на общих основаниях.
- Хранение долей — целые копейки (`i64`), как и суммы транзакций.
- **Инвариант**: `sum(share_minor) ≤ total_minor`. Допустимо оставлять часть нераспределённой в любой момент (даже когда выбрана только одна категория). Недостающая часть — это «Без категории», виртуальная строка-остаток. Не хранится в БД, всегда вычисляется как `total_minor − sum(category_shares)`.
- Поведение клика на ячейке:
  - 0 категорий → поповер выбора первой. По умолчанию новая категория получает **100%** суммы (uncategorized = 0).
  - 1+ категория → поповер добавляет ещё одну. По умолчанию **уже категоризированный пул** (`sum(текущих категорий)`) делится **равномерно** между всеми N+1 категориями; «uncategorized»-остаток остаётся прежним.
  - Иконка-карандаш в ячейке открывает полную модалку.
- В ячейке показываем максимум 3 категории (по `position`); остальные сворачиваются в общую полосу `+N` в нейтральном стиле. На hover — поповер с полным составом, точными суммами и процентами.
- В полной модалке распределение: цепочка из `N-1` слайдеров. Каждый — две шкалы (% и ₽) и два числовых input'а (% и сумма). Ввод вручную = жёсткое задание этой доли, валидация: новое значение ≤ остатка после фиксированных слева категорий.
- Сортировка категорий и в ячейке, и в модалке — по полю `position`. Дефолтное значение `position` при добавлении через инлайн-пикер — пересчитывается так, чтобы соответствовать текущему «по убыванию доли». В модалке пользователь может вручную переставить (drag/стрелки) — это обновляет `position` и порядок слайдеров.

## Steps

### 1. Миграция 009 + Rust-модуль `transaction_categories`

**Файлы:**
- создать `src-tauri/migrations/009_add_transaction_categories.sql`
- создать `src-tauri/src/transaction_categories.rs`
- править `src-tauri/src/db.rs` (регистрация миграции)
- править `src-tauri/src/lib.rs` (`mod transaction_categories;` + 2 команды в `generate_handler!`)

**Схема:**
```sql
CREATE TABLE transaction_categories (
    transaction_id  INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    category_id     INTEGER NOT NULL REFERENCES categories(id)   ON DELETE CASCADE,
    share_minor     INTEGER NOT NULL CHECK (share_minor > 0),
    position        INTEGER NOT NULL,
    PRIMARY KEY (transaction_id, category_id)
);
CREATE INDEX idx_txc_txn ON transaction_categories(transaction_id);
CREATE INDEX idx_txc_cat ON transaction_categories(category_id);
```
Нет CHECK, что сумма долей == сумма транзакции — это нельзя выразить per-row, проверка на уровне команды (см. ниже).

**Команды Rust:**
- `set_transaction_categories(transaction_id: i64, items: Vec<{category_id, share_minor, position}>) -> Result<(), String>`. Атомарно (одна `unchecked_transaction`):
  1. Проверка существования транзакции.
  2. Загрузка `credit`/`debit` транзакции, вычисление направления.
  3. Загрузка `kind` всех указанных категорий, проверка совпадения с направлением.
  4. `sum(share_minor) ≤ abs(credit + debit)` (равенство НЕ требуется — разница уходит в виртуальную «Без категории»).
  5. Проверка уникальности `category_id` и `position` в пределах списка.
  6. `DELETE FROM transaction_categories WHERE transaction_id = ?`.
  7. Пакетный `INSERT`. Пустой `items` = очистка.
- `list_transactions_categories(account_ids: Option<Vec<i64>>) -> Vec<TransactionCategoryView>`. Один SQL c `JOIN categories` для подтягивания `name`, `color`, `kind`. Если `account_ids` задан — `WHERE transaction_id IN (SELECT id FROM transactions WHERE account_id IN (...))`. Возвращает плоский список, фронт группирует.

**DTO:**
```rust
struct TransactionCategoryView {
    transaction_id: i64,
    category_id: i64,
    share_minor: i64,
    position: i64,
    category_name: String,
    category_color: String,
    category_kind: String,
}
```

**Тесты** в `transaction_categories.rs` (TempDir + db::open):
- `set_then_list_round_trip`
- `set_rejects_kind_mismatch` (income-категория на debit-транзакцию).
- `set_rejects_share_sum_exceeding_total` (отвергаем `sum > total`).
- `set_accepts_share_sum_below_total` (`sum < total` валидно — остаток идёт в виртуальную «Без категории»).
- `set_replaces_existing_atomically` (повторный `set` затирает старое).
- `cascade_on_category_delete`.
- `cascade_on_transaction_delete` (через удаление batch'а).
- `empty_items_clears_all`.

**Зависимости:** нет (это базовый слой).

### 2. API-обёртки на фронте

**Файлы:**
- править `src/lib/api.ts`

**Добавить:**
```ts
export interface TransactionCategoryView {
  transactionId: number;
  categoryId: number;
  shareMinor: number;
  position: number;
  categoryName: string;
  categoryColor: string;
  categoryKind: CategoryKind;
}

export function setTransactionCategories(args: {
  transactionId: number;
  items: { categoryId: number; shareMinor: number; position: number }[];
}): Promise<void>;

export function listTransactionsCategories(
  accountIds?: number[],
): Promise<TransactionCategoryView[]>;
```

**Зависимости:** шаг 1.

### 3. Чистая утилита распределения долей

**Файлы:**
- создать `src/lib/distribution.ts`

**Функции работают с массивом длины `n+1`, где последний элемент — виртуальная «Без категории» (uncategorized residual):**
- `equalSplit(total, n): number[]` — равные доли среди `n` категорий, последний (uncategorized) = 0.
- `addEqualToCategorized(shares, total): number[]` — добавить категорию: `categorizedSum = sum(категорий)` делим равномерно между `n+1` категориями; uncategorized сохраняем без изменений.
- `removeAt(shares, idx, total): number[]` — удаляет категорию `idx`; её доля переходит в uncategorized.
- `setShareAt(shares, idx, newValue, total): number[]` — фиксирует долю `idx`, правый хвост (включая uncategorized) масштабируется пропорционально текущим. Если хвост был нулевой — отдаём всё uncategorized'у. Округление: floor + раздача 1-копеечного остатка по убыванию дробной части.
- `setUncategorized(shares, newValue, total): number[]` — фиксирует uncat, категории слева масштабируются пропорционально, чтобы вписаться в `total - newUncat`.
- `percentOf(share, total): number` — для отображения (1 знак).

**Тесты** — отдельный `src/lib/distribution.test.ts` опционально (фронтовых тестов нет в проекте, можно ограничиться покрытием через юзерфлоу).

**Зависимости:** нет.

### 4. Утилита дерева категорий + поповер выбора

**Файлы:**
- создать `src/lib/category-tree.ts` — вынести из `Categories.tsx` функцию `buildTree(categories, kind)` и интерфейс `CategoryNode`. Обновить `Categories.tsx` на импорт.
- создать `src/components/CategoryPickerPopover.tsx`.

**Поведение поповера:**
- Props: `kind: CategoryKind`, `excludeIds: number[]` (уже выбранные), `anchorRect: DOMRect`, `onPick(categoryId)`, `onClose()`.
- Загружает `listCategories` сам (или принимает props — вынесу решение в реализацию).
- Рендерит дерево через тот же рекурсивный `CategoryNode`. Уже выбранные — в стиле `disabled` (`opacity` + `pointer-events: none`).
- Можно выбрать любую ноду (root или вложенную). Клик закрывает поповер.
- Поиск по имени (input в шапке) — фильтрация по дереву с раскрытием совпавших родителей.
- Позиционирование: ниже якоря, шириной 280px; при выходе за вьюпорт — над якорем.

**Зависимости:** существующий `Categories.tsx` (рефакторинг утилит).

### 5. Виджет ячейки `CategoriesCell`

**Файлы:**
- создать `src/pages/transactions/CategoriesCell.tsx`
- править `src/pages/Transactions.tsx` (заменить placeholder `{showCategory && <td className="cell-placeholder">—</td>}` на `<CategoriesCell ... />`)

**Props:**
```ts
{
  transactionId: number;
  totalMinor: number;          // абсолютная сумма (credit+debit)
  kind: CategoryKind;          // "income" | "expense"
  entries: TransactionCategoryView[];   // уже отсортированы по position
  onChanged: () => void;       // пересчитать данные
}
```

**Рендер:**
- Если `entries.length === 0`: пустое поле, клик открывает `CategoryPickerPopover` (`onPick` → `setTransactionCategories({ items: [{ categoryId, shareMinor: totalMinor, position: 0 }] })`).
- Иначе: горизонтальный flex-контейнер с полосами:
  - Первые 3 категории по `position` → `<div style={{ flex: shareMinor, backgroundColor: color }}>{name}</div>`.
  - Остальные → одна полоса `+N` в нейтральном цвете.
  - Если `sum(shares) < totalMinor` — серая полоса «Без категории» с диагональной штриховкой в конце (`flex: totalMinor - sum`).
  - Поверх — крошечная иконка-карандаш в правом верхнем углу, `onClick` → открывает `CategoryDistributionModal`.
  - Клик по фону полосы (не по карандашу) → открывает `CategoryPickerPopover`, после выбора:
    - `newShares = addEqualToCategorized(currentShares, total)`;
    - `position` пересчитывается по убыванию `share`;
    - `setTransactionCategories(...)`.
  - Hover — поповер-tooltip со списком всех категорий + строка «Без категории» (если есть остаток): свотч + имя + сумма + процент.

**Доступ к `totalMinor`:**
- В `Transaction` уже есть `credit` и `debit` как строки. Парсим через `parseMoneyMinor` (уже есть в `src/lib/money.ts`).

**Зависимости:** шаги 1, 2, 3, 4.

### 6. Полная модалка `CategoryDistributionModal`

**Файлы:**
- создать `src/components/CategoryDistributionModal.tsx`

**Структура:**
- Header: «Распределение категорий» + сумма транзакции справа.
- Body:
  - Список категорий по `position`. Для каждой:
    - кнопки `↑` / `↓` (передвинуть в `position-1` / `position+1`)
    - цветной свотч + имя
    - кнопка-крестик «удалить» (включая случай `entries.length === 1` — после удаления остаётся пустая ячейка, 100% «Без категории»)
  - **Виртуальная строка «Без категории»** в самом конце списка, всегда видна. Серый свотч с диагональной штриховкой, имя «Без категории», свои % и ₽-инпуты. Не удаляется и не переставляется.
  - Кнопка «+ Добавить категорию» → `CategoryPickerPopover` (anchored, исключая уже выбранные). После выбора: `addEqualToCategorized` + новая запись в конец списка категорий (перед «Без категории»).
  - Заголовок секции «Распределение».
  - Цепочка из `N` блоков-слайдеров (по одному на каждую реальную категорию):
    ```
    [#] категория_i
    Top scale: 0% — 100%   (внутри: вертикальные тики 25/50/75)
    [============●==========]   ← <input type="range" min=0 max=R_i>
    Bottom scale: 0₽ — R_i
    [_____ %] [_______ ₽]      (контролируемые input'ы)
    ```
    `R_i = totalMinor − sum(share_j for j < i)` — остаток для категории `i` и хвоста (включая «Без категории»).
  - У «Без категории» **слайдера нет**, есть только два display-инпута (% и ₽); ввод значения = жёсткое задание остатка, при котором категории слева масштабируются пропорционально.
- Footer: `[Отмена]` `[Сохранить]`.

**Локальное состояние:**
- `shares: number[]` длины `N+1` (последний — uncategorized) + параллельный массив meta-записей `{ categoryId, name, color }`.
- Изменения локальны до нажатия «Сохранить».

**Логика слайдеров:**
- `onChange(i, newValue)` для категории: clamp в `[0, R_i]` → `setShareAt(shares, i, newValue, total)`.
- `onChangeUncategorized(newValue)`: clamp в `[0, total]` → `setUncategorized`. Категории слева масштабируются пропорционально.
- Ввод процента: `newShare = round(percent / 100 * R_i)`, далее как `onChange`.
- Ввод суммы: `newShare = parseMoneyMinor(input)`, далее как `onChange`.
- Все слайдеры/инпуты работают синхронно поверх единого массива долей.

**Удаление/добавление:**
- Удаление категории `idx`: `removeAt`. Освободившаяся доля уходит в uncategorized.
- Добавление: `addEqualToCategorized` + новая запись в конец списка категорий (перед uncategorized).
- Перестановка ↑/↓: swap элементов категорий + пересчёт `position`. Uncategorized нельзя переставлять.

**Валидация на сохранение:**
- Фильтруем категории с `share === 0` (просто не записываем).
- `sum(shareMinor) ≤ totalMinor` (защитная проверка; всегда выполняется по построению).

**Зависимости:** шаги 2, 3, 4.

### 7. Загрузка данных в `Transactions.tsx`

**Файлы:**
- править `src/pages/Transactions.tsx`

**Изменения:**
- В `useEffect` (или туда же, где грузится `listTransactions`) — параллельно вызвать `listTransactionsCategories(selectedAccountIds)`.
- Сгруппировать в `Map<transactionId, TransactionCategoryView[]>` (отсортировав по `position`).
- В `<tbody>` передать в `<CategoriesCell entries={...} />`.
- `onChanged` → инкремент локального `version`/перезапрос обоих списков.

**Зависимости:** шаги 1, 2, 5.

### 8. i18n + стили

**Файлы:**
- править `src/i18n/locales/ru.json`, `src/i18n/locales/en.json`
- править `src/App.css`

**i18n-ключи (под `transactions.categories.*`):**
- `pickerTitle`, `pickerSearchPlaceholder`, `pickerEmpty` («Категорий ещё нет»).
- `cellEmpty` («Без категорий»).
- `cellMore` («+{count}»).
- `cellUncategorized` («Без категории»).
- `editButton` (label для иконки-карандаша).
- `modalTitle` («Распределение категорий»).
- `modalTotal` («Сумма транзакции»).
- `modalAddCategory` («+ Добавить категорию»).
- `modalRemove`, `modalMoveUp`, `modalMoveDown`.
- `modalDistribution` («Распределение»).
- `modalEmpty` («Выберите хотя бы одну категорию»).
- `modalErrorZeroShare` («У категории «{name}» нулевая доля. Удалите её или задайте сумму»).

**Стили `.txn-categories-*`:**
- `.txn-categories-cell` — flex container, height: 100%, position: relative.
- `.txn-categories-bar` — flex item, фон по цвету, отображение имени с `text-overflow: ellipsis`, hover-подсказка через `title` атрибут, дополнительно tooltip-popover.
- `.txn-categories-bar--more` — нейтральный фон.
- `.txn-categories-bar--uncategorized` — серый фон с диагональной штриховкой.
- `.txn-categories-edit-btn` — абсолютная позиция top-right, виден только на hover ячейки.
- `.distribution-modal-*` — для модалки.
- Поддержка dark-mode по тому же паттерну, что и для `.categories-*`.

**Зависимости:** шаги 5, 6.

### 9. Verification

**Тесты:**
```bash
cd src-tauri && cargo test --lib   # +7 новых тестов в transaction_categories
npm run build                       # tsc + Vite build
```

**Ручные сценарии (через `./scripts/dev.sh`):**
- На пустой транзакции `debit = 1000.00`: клик на ячейку → видно дерево «Расходы», income-категории не показаны. Выбираю «Еда» → ячейка сразу окрашена 100% «Едой».
- Клик ещё раз → пикер с «Едой» disabled, выбираю «Дети» → 50/50.
- Клик в третий раз → выбираю «Химия» → 33.33/33.33/33.34 (последний поглощает остаток).
- Открываю карандашом модалку: вижу 3 категории по `position`, цепочку из 2 слайдеров. Двигаю первый до 40% → второй слайдер показывает 50/50 в остатке = 30%/30% от общей суммы. Сохраняю.
- В ячейке полосы 40/30/30 (по убыванию доли).
- Hover на ячейку — поповер с точными цифрами и процентами.
- Удаляю категорию «Дети» в `/categories` → ячейка показывает 40% «Еды» + 30% «Химии» + 30% серой «Без категории».
- Поступление `credit = 50000.00`: пикер показывает только income-ветку.
- Корректирующая транзакция (`is_correcting = true`): ячейка работает как обычная.
- Удаление транзакции (через удаление батча): записи в `transaction_categories` ушли каскадом.

## Open questions

- **Точность отображения процентов**: округление до 1 знака после запятой? Или до целых? *Рекомендация для реализации: 1 знак, чтобы 33.33% не превращалось в 33%.*
- **Перенос модалки на мобильный/маленький экран**: проект только desktop, можно зафиксировать ширину модалки 600–700px.
- **Drag-and-drop в модалке** vs. стрелки `↑↓`: dnd сложнее, стрелки достаточны для MVP. *Делаем стрелки.*

## Files — итог

**Создать:**
- `src-tauri/migrations/009_add_transaction_categories.sql`
- `src-tauri/src/transaction_categories.rs`
- `src/lib/distribution.ts`
- `src/lib/category-tree.ts`
- `src/components/CategoryPickerPopover.tsx`
- `src/components/CategoryDistributionModal.tsx`
- `src/pages/transactions/CategoriesCell.tsx`

**Изменить:**
- `src-tauri/src/db.rs` — миграция 009
- `src-tauri/src/lib.rs` — модуль + команды
- `src/lib/api.ts` — типы и обёртки
- `src/pages/Categories.tsx` — импорт `buildTree` из общей утилиты
- `src/pages/Transactions.tsx` — загрузка категорий, рендер `CategoriesCell`
- `src/i18n/locales/{ru,en}.json` — ключи `transactions.categories.*`
- `src/App.css` — стили
- `TODO.md` — переводы между секциями
