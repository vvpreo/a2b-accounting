# A2B Accounting

> Last updated: 2026-08-27

A self-hosted, single-user web application for tracking and planning personal finances. Table-first UI, local SQLite database, focused on development speed and manual entry / bank-statement imports. Ships as a Docker image; the project started as a Tauri desktop app — the entire Rust backend was kept, and the Tauri layer was replaced with an HTTP server (axum).

## Quick Start (Docker, production use)

Every push to `main` builds a multi-arch image (`linux/amd64` + `linux/arm64`) and publishes it to Docker Hub (workflow [.github/workflows/docker-image.yml](.github/workflows/docker-image.yml)). Tags:

- `vvpreo/a2b-accounting:dev` — rolling build of the newest `main` commit (what docker-compose pulls by default);
- `vvpreo/a2b-accounting:sha-<commit>` — immutable per-commit tag;
- `vvpreo/a2b-accounting:latest` — the last **stable** build; promoted by a separate process, never pushed by this workflow.

```bash
# 1. Log in to Docker Hub (once; only needed while the Docker Hub repo is private)
docker login

# 2. Run with your own data (docker-compose.yml lives in the repo root,
#    but the single file is self-contained — copying it anywhere works)
FINANCES_DATA_DIR="$HOME/finances-data" docker compose up -d --pull always

# 3. Open http://127.0.0.1:3700
```

The port is published on loopback only (`127.0.0.1:${FINANCES_PORT:-3700}`) — nothing is exposed to the network. The image contains no data and no keys: the DB lives in the mounted directory, and the AI-provider key is stored in the DB itself (`app_settings`; an `env:VAR` reference is supported too).

**Where the data lives:** `$FINANCES_DATA_DIR/finances.db` (plus WAL files) on the host. Migrations are applied automatically on startup (see `db.rs` and the idempotent `schema_migrations` table), so upgrading the image is just `docker compose pull && docker compose up -d`. To migrate data from the old desktop build, simply copy `~/Library/Application Support/net.vvpreo.finances/finances.db` into `$FINANCES_DATA_DIR/`.

## Quick Start (development)

```bash
# 1. Prerequisites: Node.js ≥ 20, Rust stable (rustup.rs)

# 2. Install dependencies
npm install

# 3. Run in dev mode: axum backend (cargo run, :3701) + Vite (:3700, hot reload)
export FINANCES_DATA_DIR="$HOME/.a2b-accounting"
./scripts/dev.sh
```

If the project root has an `.envrc` with `FINANCES_DATA_DIR`, direnv picks it up automatically.

## Architecture

Two layers talking over HTTP (a JSON-RPC-like contract, 1:1 with the former Tauri `invoke`):

```
┌──────────────────────────────────────────────┐
│  Browser (React 19 + TS + Vite)              │
│    src/pages/      — screens                 │
│    src/components/ — reusable blocks         │
│    src/lib/api.ts  — typed RPC wrappers      │
│    src/lib/events.ts — SSE subscription      │
│    src/lib/csv.ts  — CSV parsing (papaparse) │
│    src/lib/colors.ts       — palette + shades │
│    src/lib/distribution.ts — cascading shares │
│    src/lib/category-tree.ts — tree building   │
└───────────────────┬──────────────────────────┘
                    │  POST /api/rpc/<cmd>  (+ GET /api/events — SSE,
                    │  GET /api/backup, POST /api/restore)
┌───────────────────▼──────────────────────────┐
│  Rust backend (axum)                         │
│    server/src/http.rs — router + RPC dispatch │
│    server/src/host.rs — AppHandle/State/events│
│    server/src/accounts.rs, transactions.rs,  │
│    categories.rs, transaction_categories.rs… │
│    server/src/db.rs    — migrations          │
│    server/src/money.rs — minor units ⇄ "123.45" │
└───────────────────┬──────────────────────────┘
                    │  rusqlite (Mutex<Connection>)
┌───────────────────▼──────────────────────────┐
│  SQLite                                      │
│    $FINANCES_DATA_DIR/finances.db            │
└──────────────────────────────────────────────┘
```

Principles:
- The HTTP contract mirrors the former Tauri `invoke`: every command is `POST /api/rpc/<name>` with camelCase JSON arguments; errors come back as a string (often a stable code the UI localises) with status 400. The dispatcher is a single macro-powered `match` in [server/src/http.rs](server/src/http.rs).
- Backend events (exchange-rate download progress) reach the browser via SSE `GET /api/events`; [src/lib/events.ts](src/lib/events.ts) provides a `listen()` interface identical to Tauri's.
- All SQL lives on the Rust side; TypeScript knows nothing about the schema.
- Money is `INTEGER` in minor currency units (cents/kopecks), scale = 2. Conversion via `rust_decimal` in Rust and strings on the frontend; the frontend has `parseMoneyToMinor` / `formatMinorAsMoney` for minor-unit operations (shares, sliders).
- Dates: every transaction stores `occurred_at_utc` (ISO-8601 UTC for comparison and storage), plus a `timezone_offset` (`+03:00`) at the import-batch level. The UI renders dates in the OS-local timezone, with the original UTC timestamp shown in the cell's hover tooltip.
- Transaction imports are grouped into batches (`import_batches`); deleting a batch cascades to all its transactions.
- Migrations are a `(version, name, sql)` array in `db.rs`, applied incrementally through the `schema_migrations` table.
- User settings live in the `app_settings (key, value)` table + `get_setting` / `set_setting` commands. Currently a single key — `locale`.
- Categories are a separate table with arbitrary nesting (`parent_id`); the `kind ∈ {income, expense}` field is stored on every row and inherited by descendants; the UI caps the tree at three levels.
- Transaction-to-category links: `transaction_categories(transaction_id, category_id, share_minor, position)`. The sum of shares is `≤` the transaction amount; the remainder is a virtual "Uncategorized" computed on the fly. Atomic replacement via `set_transaction_categories`.
- Transfer links between own accounts: `transaction_links(txn_a_id, txn_b_id)`. Stored as the canonical pair `txn_a_id < txn_b_id`; each transaction participates in at most one link. The backend (`link_transactions`) validates: different accounts, opposite directions (one credit, one debit), no other existing links. The linked transaction's categories stay as they are. The report excludes transactions from aggregation only when *both sides* of a link fall into its account selection and date range — otherwise the visible side is counted normally.
- Import is built on top of a **universal CSV** (`occurred_at,credit,debit,balance,peer,bank_description,comment`). Each bank preset registers a plugin in [src/lib/import-formats/](src/lib/import-formats/) that converts its export (CSV/XLS/PDF) into the universal CSV — from there the shared validation/preview pipeline takes over. This keeps all duplicate detection and balance-chain checking in one place and makes parser tests a trivial string comparison.
- i18n: a custom React Context + JSON files in [src/i18n/locales/](src/i18n/locales/). Initial languages: `ru`, `en`. Default = system language via `navigator.language`, fallback — `en`. A new language = a new JSON file + an entry in `LANGUAGES`.

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
                          ON DELETE CASCADE (both FKs)
categories               (id, name, color, kind, parent_id → categories, created_at)
                          CHECK (kind IN ('income','expense'))
                          UNIQUE(parent_id, name)
                          ON DELETE CASCADE (parent_id)
transaction_categories   (transaction_id → transactions, category_id → categories,
                          share_minor, position)
                          PRIMARY KEY (transaction_id, category_id)
                          CHECK (share_minor > 0)
                          ON DELETE CASCADE (both FKs)
transaction_links        (id, txn_a_id → transactions, txn_b_id → transactions,
                          created_at)
                          CHECK (txn_a_id < txn_b_id)
                          UNIQUE (txn_a_id), UNIQUE (txn_b_id)
                          ON DELETE CASCADE (both FKs)
currencies               (code PK, name, symbol, rate_source)
app_settings             (key, value)
schema_migrations        (version, name, applied_at)
```

## Repository Structure

```
a2b-accounting/
├── src/                              React + TS frontend
│   ├── App.tsx                       tabs; on startup auto-selects Transactions if any exist, Accounts otherwise
│   ├── App.css                       styles (no Tailwind)
│   ├── main.tsx                      bootstrap: load locale from the DB + I18nProvider
│   ├── components/
│   │   ├── Tabs.tsx                  top navigation (Accounts/Transactions left, Categories/Settings right)
│   │   ├── MultiSelectDropdown.tsx   generic multi-select
│   │   ├── CategoryPickerPopover.tsx anchored category-picker popover with search and kind filter
│   │   └── CategoryDistributionModal.tsx share-distribution modal with cascading sliders
│   ├── i18n/
│   │   ├── index.ts                  Context, Provider, useT/useTPlural hooks, LANGUAGES registry
│   │   └── locales/
│   │       ├── ru.json               Russian translations
│   │       └── en.json               English translations
│   ├── lib/
│   │   ├── api.ts                    typed RPC wrappers (fetch → /api/rpc/<cmd>)
│   │   ├── account-presets.ts        bank presets (default currency, default TZ offset, supported statement formats)
│   │   ├── colors.ts                 category palette + shade derivation from the parent hue
│   │   ├── category-tree.ts          buildTree/flattenTree (shared by Categories.tsx and the picker)
│   │   ├── import-formats/           statement-parser registry (format plugins)
│   │   │   ├── index.ts                    registry + parseByFormat(formatId, text, t)
│   │   │   ├── types.ts                    shared types (CsvParseResult, ImportFormatPlugin, Translate)
│   │   │   ├── universal-csv.ts            generic-csv-v1: universal CSV via papaparse
│   │   │   ├── kasikorn-csv-v1.ts          Kasikorn (KBank): bank CSV → universal CSV → universal-csv
│   │   │   ├── kasikorn-pdf-v1.ts          Kasikorn PDF: positional text → universal CSV (pdfjs-dist, balance delta)
│   │   │   └── bangkok-bank-csv-v1.ts      Bangkok Bank (BBL): bank CSV → universal CSV → universal-csv
│   │   ├── pdf-extract.ts                  pdfjs-dist wrapper: ArrayBuffer + password → PdfLine[] (dynamic import, worker via ?url)
│   │   ├── distribution.ts           equalSplit/addEqualToCategorized/setShareAt etc. — pure share math in minor units
│   │   └── money.ts                  formatMoney + parseMoneyToMinor + formatMinorAsMoney
│   └── pages/
│       ├── Accounts.tsx              account list, form, detail sub-view with the "Uploads" panel and validation
│       ├── Transactions.tsx          transaction table with filters, sticky header, month grouping and the category column
│       ├── transactions/
│       │   └── CategoriesCell.tsx    category cell: proportional bars, hover tooltip, inline picker, pencil button
│       ├── Categories.tsx            category CRUD: two sections (Income/Expenses), tree up to 3 levels, hover + and ✎ buttons
│       ├── Settings.tsx              language selector (stored in the DB), backup/restore, data dir info
│       └── ImportDialog.tsx          two-step CSV import wizard (preview + import)
├── server/                           Rust backend (axum HTTP server)
│   ├── Cargo.toml                    dependencies: axum, tower-http, tokio, rusqlite, rust_decimal, chrono, reqwest, zip
│   ├── migrations/
│   │   ├── 001_init.sql              accounts, import_batches, transactions
│   │   ├── 002_add_account_name.sql  accounts.name
│   │   ├── 003_add_transaction_peer.sql  transactions.peer
│   │   ├── 004_move_timezone_to_import_batch.sql  import_batches.timezone_offset, drop transactions.occurred_at_tz
│   │   ├── 005_add_app_settings.sql  app_settings (key, value) table
│   │   ├── 006_replace_description_columns.sql  transactions.bank_description + transactions.comment
│   │   ├── 007_add_transaction_is_correcting.sql  transactions.is_correcting
│   │   ├── 008_add_categories.sql    categories table (kind, parent_id, color)
│   │   ├── 009_add_transaction_categories.sql  transaction_categories table
│   │   └── 013_add_currencies.sql    currency dictionary + Frankfurter snapshot seed (rate_source)
│   └── src/
│       ├── main.rs                   entry point (a2b-accounting-server)
│       ├── lib.rs                    resolve_data_dir + open_and_init + tokio/axum bootstrap
│       ├── http.rs                   axum router: /api/rpc/<cmd>, /api/events (SSE), /api/backup, /api/restore, static files
│       ├── host.rs                   AppHandle/State/emit — replacement for the Tauri primitives
│       ├── db.rs                     DB opening, migrations, tests
│       ├── money.rs                  parse_minor / format_minor + unit tests
│       ├── accounts.rs               create/list/update/delete + commands
│       ├── transactions.rs           import/list (filtered by account_ids)/delete_batch/validate/preview
│       ├── categories.rs             create/list/update/delete + kind inheritance + tests
│       ├── transaction_categories.rs set/list with kind checks, sum invariant and cascades + tests
│       ├── currencies.rs             list_currencies (currency dictionary + rate_source) + tests
│       ├── settings.rs               get_setting / set_setting (UPSERT into app_settings)
│       └── backup.rs                 backup_zip_bytes / restore_from_zip_bytes / data_dir_info + tests
├── Dockerfile                        multi-arch image: frontend (Vite) + cross-compiled Rust + slim runtime
├── docker-compose.yml                local run of the Docker Hub image (loopback port, data volume)
├── scripts/
│   ├── dev.sh                        dev run (axum on :3701 + Vite on :3700)
│   └── build.sh                      release build without Docker (dist/ + release binary)
├── samples/                          example statements (for manual import testing)
│                                     layout: samples/<preset-id>/<format-id>/<filename>
│                                     — real bank statements are never committed (PII)
├── docs/plans/                       plans for major features
├── TODO.md                           task queue
└── .envrc                            FINANCES_DATA_DIR="$(pwd)/data" (direnv)
```

## Usage

### Development mode
```bash
./scripts/dev.sh
```
The script validates `FINANCES_DATA_DIR`, converts a relative path to an absolute one, puts Rust on PATH and starts two processes: `cargo run` (axum backend on `127.0.0.1:3701`) and the Vite dev server on `http://localhost:3700`, which proxies `/api` to the backend.

### Building the Docker image
```bash
docker build -t a2b-accounting:local .
docker run -d -p 127.0.0.1:3700:8080 -v "$HOME/finances-data:/data" a2b-accounting:local
```
CI does the same for `linux/amd64` + `linux/arm64` and pushes to Docker Hub ([.github/workflows/docker-image.yml](.github/workflows/docker-image.yml)). The Rust stage cross-compiles on the builder's native platform (no QEMU-emulated compiler).

### Release build without Docker
```bash
./scripts/build.sh
```
Produces `dist/` (frontend) and `server/target/release/a2b-accounting-server`.

### Tests
```bash
cd server && cargo test --lib
```
196 unit tests cover: money parsing/formatting, migration idempotency, FK cascades, CHECK constraints, balance-chain validation, category behaviour (kind CHECK, sibling UNIQUE, cascading deletes) and transaction-category links (kind matching, sum invariant, atomic replacement, both cascades).

Frontend — `npm test` (Vitest) + a tsc check via `npm run build`. Bank-statement parser tests keep their fixtures **inline** in the test code: real statements are never committed, so tests must not depend on files in `samples/`.

### Manual import testing
The `samples/` folder holds examples — a valid chain / a balance gap for the generic format, plus a subfolder per bank preset (`samples/<preset-id>/<format-id>/`). Real bank statements are **never committed** to the repository (they contain PII) — keep yours locally; they must not end up in a commit.

### Supported statement formats

| Preset | Format ID | Source |
|---|---|---|
| Generic | `generic-csv-v1` | Any CSV in our universal format |
| Bangkok Bank | `bangkok-bank-csv-v1` | `MyDownLoad*.csv` export from BBL iBanking / Bualuang mBanking |
| Kasikorn Bank | `kasikorn-csv-v1` | K-DEPOSIT `resultFile_*.csv` export from K PLUS / KBank web |
| Kasikorn Bank | `kasikorn-pdf-v1` | `STM_*.pdf` statement from K PLUS / Statement Request (encrypted; the password is usually the account owner's birth date as DDMMYYYY) |

For **Kasikorn** the parser automatically:
- skips the 12 header lines (account details, period, totals) and the `Beginning Balance` row;
- normalises numbers `"90,000.00"` → `90000.00`;
- expands `DD-MM-YY` dates to `YYYY-MM-DD` (21st century);
- assembles `bank_description` from `Description · Channel · Details`;
- extracts `peer` from `Details` (`From <…>` / `To <…>` / `Paid for Ref X#### <…>`); for system `Ref Code …` rows `peer` stays empty.

For **Kasikorn PDF** the parser (`kasikorn-pdf-v1`) additionally:
- decrypts the PDF with a password entered in the import wizard (for KBank this is usually the account owner's birth date as `DDMMYYYY`); the password is not stored in the DB;
- works off the positional text layer via `pdfjs-dist` (dynamically loaded as a separate ~1.6 MB chunk);
- resolves each text fragment's column by its X coordinate (fixed thresholds matching the bank's PDF template), which lets it correctly glue line wraps both in `Details` (`Paid for Ref X3001 PTTST.D CHUTIVAT (A/C` + `Name: CHUTIWAT PART.,LTD.)`) and in `Channel` (`ATM Mai Khaolak Beach` + `Resort & Spa (Takua ++`);
- determines the operation direction (credit/debit) from the sign of the `Outstanding Balance` change between rows (the bank collapses Withdrawal and Deposit into one visual band, so X alone can't tell them apart);
- validates balance-chain integrity across page boundaries via each page's `Beginning Balance`.

For **Bangkok Bank** the parser automatically:
- skips the header (Account/Card numbers, Ledger/Available Balance), the `Total` row and the Disclaimer;
- normalises numbers `"12,030.00"` → `12030.00`;
- parses `"DD MMM YYYY HH:MM"` (English months, e.g. `27 Apr 2026 11:50`) → `YYYY-MM-DDTHH:MM:00`;
- reverses the row order (BBL exports newest-first) — the resulting universal CSV is chronological;
- assembles `bank_description` from `Description · Channel` (e.g. `Payment for Goods /Services · MOB`);
- leaves `peer` empty — the export carries no counterparty.

The exports carry no time-zone offset; ImportDialog fills in the preset default (`+07:00` for Kasikorn/Bangkok Bank).

### Import CSV format
```
occurred_at,credit,debit,balance,peer,bank_description,comment
2026-04-01T10:15:00+03:00,,150.00,12340.50,Coffee shop,Morning coffee,
2026-04-02T09:00:00+03:00,50000.00,,62340.50,Employer,Salary,
```
- `occurred_at` — ISO-8601 (offset required; if omitted, the wizard's default is applied)
- `credit` / `debit` — exactly one of the two is filled (empty = 0)
- `balance` — the balance AFTER the operation
- `peer` — counterparty (source / recipient)
- `bank_description` / `comment` — two independent text fields

## Configuration

### Environment variables (server)
- **`FINANCES_DATA_DIR`** — absolute path to the data directory (`finances.db` + WAL). Set to `/data` in the Docker image (where the volume mounts); set via `.envrc` in dev. When unset — falls back to `~/.local/share/net.vvpreo.finances/`. The path is created if missing.
- **`FINANCES_BIND`** — address:port for the HTTP server. Default `127.0.0.1:3701` (dev); in the image — `0.0.0.0:8080` (Docker decides what to publish, loopback-only on the host by default).
- **`FINANCES_STATIC_DIR`** — directory with the built frontend. `/app/static` in the image; not needed in dev (Vite serves the frontend).

### docker-compose variables
- **`FINANCES_PORT`** — port on the host loopback (default `3700`).
- **`FINANCES_DATA_DIR`** — host directory with the data (default `./data`).

### Dev-mode notes
- SQLite WAL mode is on (`PRAGMA journal_mode=WAL`) — `-wal` and `-shm` files appear next to the `.db`.
- The Vite dev server ignores changes under `server/**` (see [vite.config.ts](vite.config.ts)); Rust changes require restarting `./scripts/dev.sh` (or a separate `cargo run`).

## Development

- **Node.js** ≥ 20, **Rust** stable via `rustup`.
- Rust tests: `cd server && cargo test --lib`. Frontend tests: `npm test` (Vitest) + a tsc check via `npm run build`.
- Native JS dialogs (`window.confirm`, `window.alert`, `window.prompt`) are not used — inline confirmations in the UI only (a rule inherited from the Tauri webview days that also keeps the UX consistent).
- Money never travels through floating-point `number` — only `"123.45"` strings at the boundary and `i64` minor units inside.
- Actions (create an account, import transactions) live in the header of their screen — there is no global toolbar.
- On startup the app performs a single `listTransactions()` and switches to the Transactions tab when any exist; otherwise it stays on Accounts.

## Current Status

Done:
- Data model and migration schema (accounts, transactions, import batches, settings, categories, transaction-category links).
- Account CRUD with bank presets and balance-chain validation on the detail page.
- Two-step CSV import wizard: preview with issue highlighting (duplicates, gaps), automatic creation of correcting transactions.
- Transactions tab: multi-select account filter, sticky header, month grouping in local time, content-driven widths for the first 5 columns, an elastic comment column, local date display with the UTC timestamp in the title tooltip.
- Category column in the transaction table: proportional coloured bars, a grey "Uncategorized" bar for the unallocated remainder, hover tooltip with exact amounts and percentages, an inline category picker with search and kind filter, a pencil icon opening the modal with cascading sliders for fine-tuning the distribution.
- Category dictionary: income/expense hierarchy up to three levels in the UI, a colour palette with auto-derived shades, compact + and ✎ icons on row hover.
- Transfer links between own accounts: a 🔗 column on the Transactions tab, two-click linking with validation (different accounts, opposite directions, not already linked), unlinking behind a confirmation. Mutually covering pairs are excluded from the report automatically.
- i18n (ru/en), the selected language stored in the DB.
- Web delivery: an axum server with an RPC contract 1:1 with the former Tauri `invoke`, SSE events, a multi-arch Docker image, CI publishing to Docker Hub, docker-compose for a local run with your own data.
- DB backup and restore via the UI (Settings): browser ZIP download (preceded by `wal_checkpoint(TRUNCATE)`), restore by uploading an archive with validation (valid SQLite + a `schema_migrations` table present) and automatic renaming of the current `finances.db` to `finances.db.bak-<UTC-timestamp>`. After a restore the server reopens the DB in place and the page reloads.
- The data directory is fixed at server startup (`FINANCES_DATA_DIR` / Docker volume); Settings displays the current path. Runtime directory switching from the UI was removed together with the desktop build.

In the queue (`TO REVIEW` in [TODO.md](TODO.md)):
- Acceptance of the desktop → web migration (Docker image, registry publishing, compose).
- Acceptance of the category dictionary.
- Acceptance of the data model and import.

Not in the MVP:
- Auto-categorisation (rules that assign categories to imported transactions automatically).
- Tags, reports, budgets.
- Multi-currency transfers between accounts.
- Bank-specific parsers for every bank (currently the universal CSV plus the presets listed above).
- Editing a single transaction — currently only bulk import + comment + categories + batch deletion.
- Currencies with scale ≠ 2 (JPY, KWD).
- DB encryption.
