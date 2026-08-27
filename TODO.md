# TODO

- [ ] [Привязка категорий к транзакциям с распределением долей](docs/plans/transaction-categorization.md)
- [ ] [Tabs navigation, multi-select transactions filter, i18n (ru/en)](docs/plans/tabs-navigation-and-i18n.md)
- [ ] Пусть приложение стартует с окна, которое занимает всю рабочую поверхность но не полноэкранный режим. Если пользователь ресайзит - то это сохранятеся в БД и потом восстанавливается при повторном запуске.
- [ ] закрепить хедер и 1 колонку на странице отчета
- [ ] Добавить поддержку валют

# PLANNED

# TO REVIEW

- [ ] Переезд desktop → web: Tauri заменён на axum HTTP-сервер (RPC 1:1, SSE-события, backup download / restore upload), Docker-образ (multi-arch amd64+arm64), CI-публикация образа в Docker Hub, docker-compose для локального запуска
- [ ] Backup & restore in Settings: ZIP export with `wal_checkpoint(TRUNCATE)`, validated restore with auto-bak of current DB, and «switch»-mode data-dir picker driven by a pointer file in the platform-default appdata
- [ ] CI: rolling macOS DMG release on push to `main` (no signing, arm64 only) — superseded by the Docker-image pipeline (workflow removed in the web migration)
- [ ] Categories CRUD (income/expense, hierarchical tree, palette + shade-derived colors)
- [ ] [Data model & import mechanism (accounts, transactions, import batches)](docs/plans/data-model-and-import.md)
- [ ] Kasikorn PDF statement import (`kasikorn-pdf-v1`): расшифровка пароля через мастер импорта, позиционный парсер на pdfjs-dist, balance-delta для credit/debit, склейка переносов Channel/Details

# DONE

- [X] Bootstrap Tauri 2 + React + TypeScript Hello World
