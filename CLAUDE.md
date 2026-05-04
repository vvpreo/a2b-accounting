# Instructions for Claude

## First steps

**Always read `README.md` first** — it contains the up-to-date project overview, architecture, structure, and conventions. Orient yourself there before diving into specific files.

## Sample bank-statement files

Никогда не создавай и не коммить сам реальные банковские выгрузки в `samples/`. Эти файлы кладёт пользователь — они могут содержать персональные данные (имена, номера счетов, контрагенты), и их обфускация/выкладка — задача пользователя.

Структура папки: `samples/<preset-id>/<format-id>/<filename>` (например, `samples/kasikorn/kasikorn-csv-v1/statement-2025-05.csv`).

При разработке парсеров под конкретный формат тестовые фикстуры держи **inline в коде теста** (синтетический CSV-литерал), а не привязывай тесты к файлам в `samples/` — иначе тесты сломаются у того, у кого этих файлов нет.
