//! Demo data seeding.
//!
//! Auto-fires on first run when the database has no user data; users can also
//! invoke it manually from the Settings screen ("Load demo data") and undo it
//! via "Clear all data". Both paths share the same wipe → seed pipeline.
//!
//! The flag `app_settings.demo_seeded = "true"` guards the auto-fire so users
//! who explicitly cleared their data don't get demo content reappearing on the
//! next launch.
//!
//! Four accounts are seeded to mirror a realistic household setup and to lay
//! groundwork for a future "mark transfer between own accounts" feature:
//!   - Salary  ("Зарплатный счёт"): 10 years of history. The earliest 7 years
//!     are a "bachelor" period — just one paycheck and one uncategorized
//!     monthly expense, leaving a small residual every month. After that the
//!     Family account opens and the usual transfers (Family / Savings /
//!     Vacation) and small misc spends start.
//!   - Family  ("Семейный счёт"): receives the monthly transfer from Salary
//!     and occasional gifts; carries the bulk of recurring household expenses.
//!     Opens 36 months ago.
//!   - Savings ("Сберегательный счёт"): receive-only, opens 6 months after
//!     the Family account. On that opening day the entire bachelor-period
//!     residual is dumped from Salary into Savings as a single transfer.
//!     Subsequent funding is sporadic (roughly once per quarter) with
//!     variable amounts to mimic undisciplined saving behaviour.
//!   - Vacation ("На отпуск"): receive-only, opened ~8 months ago. Funded by
//!     a fixed monthly Salary→Vacation transfer added on top of the existing
//!     transfers — Salary income comfortably covers it.
//! Transfers between accounts are emitted as paired uncategorized transactions
//! (debit on the source, credit on the destination) so a future feature can
//! link the two sides without changing the schema.

use std::collections::HashMap;

use chrono::{Datelike, Months, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;

use crate::db::DbState;

const DEMO_FLAG_KEY: &str = "demo_seeded";
const DEMO_ACCOUNT_BANK: &str = "Demo Bank";
const DEMO_ACCOUNT_OWNER: &str = "Демо";
const DEMO_ACCOUNT_CURRENCY: &str = "USD";
const DEMO_ACCOUNT_TIMEZONE: &str = "+03:00";
const DEMO_REPORT_NAME: &str = "Отчёт учёта";

// ---- Accounts ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum AccountKind {
    Salary,
    Family,
    Savings,
    Vacation,
}

struct AccountSpec {
    kind: AccountKind,
    name: &'static str,
    account_number: &'static str,
}

const ACCOUNTS: &[AccountSpec] = &[
    AccountSpec {
        kind: AccountKind::Salary,
        name: "Зарплатный счёт",
        account_number: "DEMO-SAL-0001",
    },
    AccountSpec {
        kind: AccountKind::Family,
        name: "Семейный счёт",
        account_number: "DEMO-FAM-0001",
    },
    AccountSpec {
        kind: AccountKind::Savings,
        name: "Сберегательный счёт",
        account_number: "DEMO-SAV-0001",
    },
    AccountSpec {
        kind: AccountKind::Vacation,
        name: "На отпуск",
        account_number: "DEMO-VAC-0001",
    },
];

// Fixed monthly internal transfer to Family — kept as plain debits/credits
// with no category so they collapse together in the report's "Без категории"
// line.
const TRANSFER_TO_FAMILY_USD: u32 = 3_500;
// Savings transfers are deliberately irregular: each active month has a
// 1-in-3 chance of a transfer landing, with the amount drawn from a wide
// range. Demos undisciplined saving — sometimes nothing for a few months,
// sometimes back-to-back contributions of varying size.
const SAVINGS_TRANSFER_CHANCE_NUM: u32 = 1;
const SAVINGS_TRANSFER_CHANCE_DEN: u32 = 3;
const SAVINGS_TRANSFER_LO_USD: u32 = 500;
const SAVINGS_TRANSFER_HI_USD: u32 = 1_500;
// The Savings account opens this many months after the Family account.
// Anchor month = `start + SAVINGS_AGE_OFFSET_MONTHS`.
const SAVINGS_AGE_OFFSET_MONTHS: u32 = 6;
// Vacation transfer: a new outflow from Salary that didn't exist before the
// account opened. Salary inflow comfortably covers the existing transfers
// plus this one, so adding it doesn't risk underflowing any account.
const TRANSFER_TO_VACATION_USD: u32 = 400;
// Number of monthly contributions the vacation account has accumulated.
// Anchored to `today`, the first contribution lands in the month
// `today - (VACATION_ACTIVE_MONTHS - 1)`. With the typical mid-/late-month
// `today`, that means the vacation account effectively appeared ~8 months
// before today.
const VACATION_ACTIVE_MONTHS: u32 = 8;
// Total salary history. The Family account is anchored at month
// `today - 36`, so the first 84 months (= SALARY_AGE_MONTHS - 36) are the
// "bachelor" period: a single paycheck and a single uncategorized expense
// per month, with the difference accumulating until Savings opens.
const SALARY_AGE_MONTHS: u32 = 120;
const FAMILY_AGE_MONTHS: u32 = 36;
// Bachelor monthly expense range. Tuned so each month leaves a few hundred
// dollars of residual on the salary account; summed across 84 months this
// becomes a meaningful one-shot deposit when Savings opens.
const BACHELOR_EXPENSE_LO_USD: u32 = 4_200;
const BACHELOR_EXPENSE_HI_USD: u32 = 4_800;
// Separate seed for the bachelor period so its rng calls don't shift the
// existing per-month randomness used by the family/savings/vacation flows.
const BACHELOR_RNG_SEED: u64 = 0xBACE_5EED;

// Opening balance for the Family account, posted on the first seed day so the
// running balance can absorb month-to-month variance in expenses without
// dipping below zero. Salary and Savings accounts start at zero — Salary is
// continually replenished by the day-1 paycheck, and Savings is receive-only.
const OPENING_BALANCE_FAMILY_USD: u32 = 10_000;

// ---- Categories ----

struct CategorySpec {
    name: &'static str,
    color: &'static str,
    children: &'static [CategorySpec],
}

const INCOME_CATEGORIES: &[CategorySpec] = &[
    CategorySpec { name: "Зарплата", color: "#84d268", children: &[] },
    CategorySpec { name: "Подарки", color: "#d1b07d", children: &[] },
    CategorySpec { name: "Прочие доходы", color: "#5acdc1", children: &[] },
];

const EXPENSE_CATEGORIES: &[CategorySpec] = &[
    CategorySpec {
        name: "Жильё",
        color: "#5a9cc7",
        children: &[
            CategorySpec { name: "Аренда", color: "#7eb1d2", children: &[] },
            CategorySpec { name: "Коммуналка", color: "#92bcd9", children: &[] },
            CategorySpec { name: "Интернет", color: "#a6c8df", children: &[] },
        ],
    },
    CategorySpec {
        name: "Еда",
        color: "#84d268",
        children: &[
            CategorySpec {
                name: "Магазины",
                color: "#9ddb86",
                children: &[
                    CategorySpec { name: "Супермаркеты", color: "#aee29a", children: &[] },
                    CategorySpec { name: "Фермерский рынок", color: "#bce8aa", children: &[] },
                ],
            },
            CategorySpec { name: "Кафе и рестораны", color: "#b2e2a4", children: &[] },
            CategorySpec { name: "Доставка", color: "#c2e8b8", children: &[] },
        ],
    },
    CategorySpec {
        name: "Транспорт",
        color: "#e0b257",
        children: &[
            CategorySpec { name: "Общественный", color: "#e8c585", children: &[] },
            CategorySpec { name: "Такси", color: "#ecce98", children: &[] },
            CategorySpec {
                name: "Бензин",
                color: "#f0d7ab",
                children: &[
                    CategorySpec { name: "АЗС Shell", color: "#f5e3c0", children: &[] },
                    CategorySpec { name: "АЗС BP", color: "#f9ecd0", children: &[] },
                ],
            },
        ],
    },
    CategorySpec {
        name: "Здоровье",
        color: "#e05757",
        children: &[
            CategorySpec { name: "Аптека", color: "#e88080", children: &[] },
            CategorySpec {
                name: "Врачи",
                color: "#ec9494",
                children: &[
                    CategorySpec { name: "Терапевт", color: "#f0a6a6", children: &[] },
                    CategorySpec { name: "Стоматолог", color: "#f4b8b8", children: &[] },
                ],
            },
        ],
    },
    CategorySpec {
        name: "Развлечения",
        color: "#a87dd1",
        children: &[
            CategorySpec { name: "Кино и театр", color: "#b89bd9", children: &[] },
            CategorySpec {
                name: "Подписки",
                color: "#c1abdf",
                children: &[
                    CategorySpec { name: "Музыка", color: "#cdb9e3", children: &[] },
                    CategorySpec { name: "Видео", color: "#d6c5e8", children: &[] },
                ],
            },
            CategorySpec { name: "Хобби", color: "#cabae5", children: &[] },
        ],
    },
    CategorySpec { name: "Одежда", color: "#d17daf", children: &[] },
    CategorySpec { name: "Образование", color: "#5acdc1", children: &[] },
    CategorySpec { name: "Прочее", color: "#7d8ad1", children: &[] },
];

// ---- Deterministic PRNG (xorshift64*) ----

struct Rng {
    state: u64,
}

impl Rng {
    fn new(seed: u64) -> Self {
        Rng { state: if seed == 0 { 0xCAFEBABE } else { seed } }
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn range(&mut self, lo: u32, hi: u32) -> u32 {
        if hi <= lo {
            return lo;
        }
        lo + (self.next_u64() % (hi - lo) as u64) as u32
    }
    fn pick<T: Copy>(&mut self, choices: &[T]) -> T {
        choices[self.range(0, choices.len() as u32) as usize]
    }
    /// Returns true with probability `numerator / denominator`.
    fn chance(&mut self, numerator: u32, denominator: u32) -> bool {
        self.range(0, denominator) < numerator
    }
}

// ---- Transaction template ----

#[derive(Debug)]
enum Categorization {
    /// Whole amount goes to a single category — the common case.
    Full(&'static str),
    /// No category at all → entire amount becomes the residual "Без категории"
    /// when the report has `showUncategorized = true`. Also used for internal
    /// transfers between own accounts.
    None,
    /// Half goes to a category, half stays unallocated. Used to demo the
    /// partial-categorization workflow on the report.
    Half(&'static str),
    /// Explicit list of (category_name, share_minor). Sum of shares equals
    /// the transaction total — used to demo splits inside one transaction,
    /// in particular group + leaf combinations like ("Магазины", 40) +
    /// ("Супермаркеты", 90), which highlight the "tagged-on-group" amount
    /// alongside its child rows in the report.
    Multi(&'static [(&'static str, i64)]),
}

fn multi_total(parts: &[(&'static str, i64)]) -> i64 {
    parts.iter().map(|(_, s)| *s).sum()
}

// Splits used by Categorization::Multi. Amounts are in minor units (cents).
// Each tuple is (category_name, share_minor); sum equals the txn debit.
const MULTI_HYPERMARKET: &[(&str, i64)] = &[
    ("Магазины", 40_00),       // group: stuff that didn't fit a leaf
    ("Супермаркеты", 90_00),   // leaf: groceries
];
const MULTI_DOCTOR_VISIT: &[(&str, i64)] = &[
    ("Врачи", 50_00),          // group: consult
    ("Стоматолог", 80_00),     // leaf: procedure
];
const MULTI_SUB_BUNDLE: &[(&str, i64)] = &[
    ("Подписки", 5_00),        // group: base family plan
    ("Музыка", 8_00),          // leaf: add-on
];
const MULTI_GROCERY_DELIVERY: &[(&str, i64)] = &[
    ("Супермаркеты", 100_00),  // leaf under one group
    ("Доставка", 25_00),       // leaf under another — cross-group split
];

#[derive(Debug)]
struct TxnSpec {
    account: AccountKind,
    date: NaiveDate,
    credit_minor: i64,
    debit_minor: i64,
    categorization: Categorization,
    peer: Option<&'static str>,
    bank_description: Option<&'static str>,
    /// When two specs share the same tag, both surface as one internal-transfer
    /// link in the seeded `transaction_links` table. The runtime feature can
    /// then verify how the report excludes such pairs without the user having
    /// to mark anything by hand. Non-transfer specs leave this `None`.
    transfer_tag: Option<String>,
    /// Marks the row as a synthetic "correcting" entry — the kind import
    /// produces when it can't reconcile a balance jump. Combined with
    /// `Categorization::None` and no `transfer_tag`, this drives the dashed
    /// border in the activity strip so the demo data exercises that visual.
    is_correcting: bool,
}

const SHOPS: &[&str] = &["Перекрёсток", "Магнит", "Пятёрочка", "Лента", "Ашан"];
const CAFES: &[&str] = &["Кофейня", "Шоколадница", "Кафе у дома", "Coffee House"];
const DELIVERY: &[&str] = &["Яндекс.Еда", "Delivery Club", "Самокат"];
const TAXI: &[&str] = &["Яндекс.Такси", "Citymobil"];
const PHARMACY: &[&str] = &["Аптека 36.6", "Ригла", "Горздрав"];
const CINEMAS: &[&str] = &["КиноПоиск", "Каро", "Формула Кино"];
const SUBSCRIPTIONS: &[&str] = &["Яндекс.Плюс", "Spotify", "Netflix", "iCloud+"];
const HOBBIES: &[&str] = &["Спортзал", "Книги", "Игры"];
const CLOTHES: &[&str] = &["Uniqlo", "Zara", "H&M", "Lamoda"];
const EDU: &[&str] = &["Курсы английского", "Онлайн-школа", "Книжный магазин"];
const MISC: &[&str] = &["Хозтовары", "Подарок", "Сувенир", "Канцелярия"];

fn usd(amount: u32) -> i64 {
    amount as i64 * 100
}

fn usd_from_range(rng: &mut Rng, lo: u32, hi: u32) -> i64 {
    let v = rng.range(lo, hi);
    // Round to whole dollars for tidy demo values.
    usd(v)
}

fn safe_date(y: i32, m: u32, d: u32) -> NaiveDate {
    let last = days_in_month(y, m);
    NaiveDate::from_ymd_opt(y, m, d.min(last)).unwrap()
}

fn days_in_month(y: i32, m: u32) -> u32 {
    let next_first = if m == 12 {
        NaiveDate::from_ymd_opt(y + 1, 1, 1).unwrap()
    } else {
        NaiveDate::from_ymd_opt(y, m + 1, 1).unwrap()
    };
    let first = NaiveDate::from_ymd_opt(y, m, 1).unwrap();
    (next_first - first).num_days() as u32
}

fn iter_months(start: NaiveDate, end: NaiveDate) -> impl Iterator<Item = NaiveDate> {
    let mut cur = NaiveDate::from_ymd_opt(start.year(), start.month(), 1).unwrap();
    let stop = NaiveDate::from_ymd_opt(end.year(), end.month(), 1).unwrap();
    std::iter::from_fn(move || {
        if cur > stop {
            None
        } else {
            let out = cur;
            cur = cur.checked_add_months(Months::new(1)).unwrap();
            Some(out)
        }
    })
}

fn generate_transactions(today: NaiveDate) -> Vec<TxnSpec> {
    let mut rng = Rng::new(0xCAFEBABE);
    let mut bachelor_rng = Rng::new(BACHELOR_RNG_SEED);
    let mut out: Vec<TxnSpec> = Vec::new();

    // Bachelor period reaches back the full salary history; the Family,
    // Savings and Vacation accounts only become active later.
    let bachelor_start = today
        .checked_sub_months(Months::new(SALARY_AGE_MONTHS))
        .unwrap()
        .with_day(1)
        .unwrap();
    let family_start = today
        .checked_sub_months(Months::new(FAMILY_AGE_MONTHS))
        .unwrap()
        .with_day(1)
        .unwrap();
    // Inclusive of the current month so the report's "last 12 months" view always
    // has fresh data at the right edge.
    let end = today;

    // The vacation account opens `VACATION_ACTIVE_MONTHS - 1` whole months
    // before `today`, so its first contribution lands in that month and the
    // account ends up with exactly `VACATION_ACTIVE_MONTHS` monthly credits
    // including the current one. We use `>=` against this anchor to gate the
    // per-month emission.
    let vacation_start = today
        .checked_sub_months(Months::new(VACATION_ACTIVE_MONTHS - 1))
        .unwrap()
        .with_day(1)
        .unwrap();

    // The Savings account opens `SAVINGS_AGE_OFFSET_MONTHS` after the Family
    // account. Months strictly before this anchor produce no savings transfer
    // at all (and the bachelor-residual dump fires on the very first one).
    let savings_start = family_start
        .checked_add_months(Months::new(SAVINGS_AGE_OFFSET_MONTHS))
        .unwrap();

    // Opening balance on the family account, posted on the very first day
    // the family account exists (NOT the bachelor period — Family didn't
    // exist back then). Without it, the family balance would briefly dip
    // below zero whenever a month's expenses happen to exceed the fixed
    // transfer-in (the rent alone is $2k right at the start of each month).
    // Pushed early → stable sort places it ahead of any other Family entry
    // on the same date.
    out.push(TxnSpec {
        account: AccountKind::Family,
        date: family_start,
        credit_minor: usd(OPENING_BALANCE_FAMILY_USD),
        debit_minor: 0,
        categorization: Categorization::None,
        peer: Some("Начальный остаток"),
        bank_description: Some("Начальный остаток на счёте"),
        transfer_tag: None,
        is_correcting: false,
    });

    // Running total of the bachelor-period residual (paycheck minus monthly
    // expense). Drained into Savings as a single transfer on the day Savings
    // opens.
    let mut bachelor_residual_minor: i64 = 0;

    for month_start in iter_months(bachelor_start, end) {
        let y = month_start.year();
        let m = month_start.month();

        if month_start < family_start {
            // ----- Bachelor period -----
            // Just a paycheck and one uncategorized expense per month.
            // Residual accumulates and lands on Savings as a single dump
            // when that account opens.
            out.push(TxnSpec {
                account: AccountKind::Salary,
                date: safe_date(y, m, 1),
                credit_minor: usd(5_000),
                debit_minor: 0,
                categorization: Categorization::Full("Зарплата"),
                peer: Some("ООО \"Работодатель\""),
                bank_description: Some("Заработная плата"),
                transfer_tag: None,
                is_correcting: false,
            });
            let expense = usd_from_range(
                &mut bachelor_rng,
                BACHELOR_EXPENSE_LO_USD,
                BACHELOR_EXPENSE_HI_USD,
            );
            out.push(TxnSpec {
                account: AccountKind::Salary,
                date: safe_date(y, m, 15),
                credit_minor: 0,
                debit_minor: expense,
                categorization: Categorization::None,
                peer: Some("Текущие расходы"),
                bank_description: Some("Расходы за месяц"),
                transfer_tag: None,
                is_correcting: false,
            });
            bachelor_residual_minor += usd(5_000) - expense;
            continue;
        }

        // ----- Salary account -----

        // Paycheck on the 1st: $5,000 net. Lands first in the month so the
        // outgoing transfers on day 2 / day 3 always have funds to draw from.
        out.push(TxnSpec {
            account: AccountKind::Salary,
            date: safe_date(y, m, 1),
            credit_minor: usd(5_000),
            debit_minor: 0,
            categorization: Categorization::Full("Зарплата"),
            peer: Some("ООО \"Работодатель\""),
            bank_description: Some("Заработная плата"),
            transfer_tag: None,
            is_correcting: false,
        });

        // Quarterly bonus on the 25th of Mar/Jun/Sep/Dec.
        if matches!(m, 3 | 6 | 9 | 12) {
            out.push(TxnSpec {
                account: AccountKind::Salary,
                date: safe_date(y, m, 25),
                credit_minor: usd(1_500),
                debit_minor: 0,
                categorization: Categorization::Full("Зарплата"),
                peer: Some("ООО \"Работодатель\""),
                bank_description: Some("Квартальная премия"),
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // ----- Internal transfers (Salary → Family, Salary → Savings) -----
        // Two paired uncategorized rows per transfer: debit on the source,
        // credit on the destination, same date. Future "mark internal
        // transfer" feature will link them; for now they live as plain
        // transactions and surface in the report as "Без категории" on both
        // the income and expense sides (they cancel out across accounts).

        let vacation_active = month_start >= vacation_start;

        // Day 2: salary → family. Same `transfer_tag` on both sides → seeded
        // as a transaction_links row so the demo report excludes the pair as
        // an internal transfer.
        let tag_family = format!("salary->family@{y}-{m:02}");
        out.push(TxnSpec {
            account: AccountKind::Salary,
            date: safe_date(y, m, 2),
            credit_minor: 0,
            debit_minor: usd(TRANSFER_TO_FAMILY_USD),
            categorization: Categorization::None,
            peer: Some("Семейный счёт"),
            bank_description: Some("Перевод на семейный счёт"),
            transfer_tag: Some(tag_family.clone()),
            is_correcting: false,
        });
        out.push(TxnSpec {
            account: AccountKind::Family,
            date: safe_date(y, m, 2),
            credit_minor: usd(TRANSFER_TO_FAMILY_USD),
            debit_minor: 0,
            categorization: Categorization::None,
            peer: Some("Зарплатный счёт"),
            bank_description: Some("Перевод с зарплатного счёта"),
            transfer_tag: Some(tag_family),
            is_correcting: false,
        });

        // (Salary → Savings is now sporadic and emitted at the end of the
        // month loop so its rng calls don't shift the existing per-month
        // randomness for family/multi-split flows.)

        // Day 4: salary → vacation. Only emitted while the vacation account
        // is active; before that it didn't exist yet.
        if vacation_active {
            let tag_vacation = format!("salary->vacation@{y}-{m:02}");
            out.push(TxnSpec {
                account: AccountKind::Salary,
                date: safe_date(y, m, 4),
                credit_minor: 0,
                debit_minor: usd(TRANSFER_TO_VACATION_USD),
                categorization: Categorization::None,
                peer: Some("Счёт «На отпуск»"),
                bank_description: Some("Перевод на отпускной счёт"),
                transfer_tag: Some(tag_vacation.clone()),
                is_correcting: false,
            });
            out.push(TxnSpec {
                account: AccountKind::Vacation,
                date: safe_date(y, m, 4),
                credit_minor: usd(TRANSFER_TO_VACATION_USD),
                debit_minor: 0,
                categorization: Categorization::None,
                peer: Some("Зарплатный счёт"),
                bank_description: Some("Перевод с зарплатного счёта"),
                transfer_tag: Some(tag_vacation),
                is_correcting: false,
            });
        }

        // Misc small spends on Salary (souvenirs, stationery) — leftover from
        // the salary inflow that didn't get transferred away. Demonstrates
        // that the salary account isn't strictly transfer-only.
        if rng.chance(3, 4) {
            out.push(TxnSpec {
                account: AccountKind::Salary,
                date: safe_date(y, m, rng.range(10, 28)),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 10, 70),
                categorization: Categorization::Full("Прочее"),
                peer: Some(rng.pick(MISC)),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // ----- Family account: occasional gifts -----
        if rng.chance(1, 3) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: usd_from_range(&mut rng, 50, 200),
                debit_minor: 0,
                categorization: Categorization::Full("Подарки"),
                peer: Some("Перевод от родителей"),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // ----- Family account: recurring expenses -----
        // Rent on the 4th — strictly after the day-2 transfer-in so the family
        // balance never dips below zero waiting for funds to arrive.
        out.push(TxnSpec {
            account: AccountKind::Family,
            date: safe_date(y, m, 4),
            credit_minor: 0,
            debit_minor: usd(2_000),
            categorization: Categorization::Full("Аренда"),
            peer: Some("Аренда квартиры"),
            bank_description: None,
            transfer_tag: None,
            is_correcting: false,
        });
        out.push(TxnSpec {
            account: AccountKind::Family,
            date: safe_date(y, m, 10),
            credit_minor: 0,
            debit_minor: usd_from_range(&mut rng, 100, 200),
            categorization: Categorization::Full("Коммуналка"),
            peer: Some("ЖКХ"),
            bank_description: None,
            transfer_tag: None,
            is_correcting: false,
        });
        out.push(TxnSpec {
            account: AccountKind::Family,
            date: safe_date(y, m, 15),
            credit_minor: 0,
            debit_minor: usd(30),
            categorization: Categorization::Full("Интернет"),
            peer: Some("Провайдер"),
            bank_description: None,
            transfer_tag: None,
            is_correcting: false,
        });
        out.push(TxnSpec {
            account: AccountKind::Family,
            date: safe_date(y, m, 5),
            credit_minor: 0,
            debit_minor: usd(80),
            categorization: Categorization::Full("Общественный"),
            peer: Some("Транспортная карта"),
            bank_description: Some("Пополнение проездного"),
            transfer_tag: None,
            is_correcting: false,
        });
        // Subscription rows alternate between "Музыка" and "Видео" so the
        // grandchild level under "Подписки" is visible in the demo report.
        let sub_leaf = if rng.chance(1, 2) { "Музыка" } else { "Видео" };
        out.push(TxnSpec {
            account: AccountKind::Family,
            date: safe_date(y, m, 5),
            credit_minor: 0,
            debit_minor: usd_from_range(&mut rng, 8, 25),
            categorization: Categorization::Full(sub_leaf),
            peer: Some(rng.pick(SUBSCRIPTIONS)),
            bank_description: None,
            transfer_tag: None,
            is_correcting: false,
        });

        // Cash withdrawal — kept *uncategorized* on purpose so every month has
        // a chunk of unallocated spending visible in the report.
        out.push(TxnSpec {
            account: AccountKind::Family,
            date: safe_date(y, m, 20),
            credit_minor: 0,
            debit_minor: usd_from_range(&mut rng, 80, 250),
            categorization: Categorization::None,
            peer: Some("ATM"),
            bank_description: Some("Снятие наличных"),
            transfer_tag: None,
            is_correcting: false,
        });

        // --- Variable groceries: 4 supermarket runs + maybe 1 farmer's market ---
        // Both grandchildren of "Магазины", which is itself a child of "Еда".
        for _ in 0..4 {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, days_in_month(y, m))),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 40, 150),
                categorization: Categorization::Full("Супермаркеты"),
                peer: Some(rng.pick(SHOPS)),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }
        if rng.chance(2, 3) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, days_in_month(y, m))),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 30, 90),
                categorization: Categorization::Full("Фермерский рынок"),
                peer: Some("Фермерский рынок"),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // Cafe (2-3)
        for _ in 0..rng.range(2, 4) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, days_in_month(y, m))),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 20, 80),
                categorization: Categorization::Full("Кафе и рестораны"),
                peer: Some(rng.pick(CAFES)),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // Delivery (1-3)
        for _ in 0..rng.range(1, 4) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, days_in_month(y, m))),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 25, 70),
                categorization: Categorization::Full("Доставка"),
                peer: Some(rng.pick(DELIVERY)),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // Taxi (1-3)
        for _ in 0..rng.range(1, 4) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, days_in_month(y, m))),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 10, 30),
                categorization: Categorization::Full("Такси"),
                peer: Some(rng.pick(TAXI)),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // Pharmacy: usually 1.
        if rng.chance(3, 4) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(5, 28)),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 15, 60),
                categorization: Categorization::Full("Аптека"),
                peer: Some(rng.pick(PHARMACY)),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // Doctor: roughly every other month — alternating "Терапевт" /
        // "Стоматолог" so the third-level grandchild is visible.
        if rng.chance(1, 2) {
            let doctor = if rng.chance(1, 2) { "Терапевт" } else { "Стоматолог" };
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(5, 28)),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 80, 200),
                categorization: Categorization::Full(doctor),
                peer: Some("Клиника"),
                bank_description: Some("Приём врача"),
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // Fuel: ~once a month at one of the chains. Exercises the "Бензин"
        // grandchildren (АЗС Shell / АЗС BP).
        if rng.chance(3, 4) {
            let station = if rng.chance(1, 2) { "АЗС Shell" } else { "АЗС BP" };
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(3, 28)),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 30, 90),
                categorization: Categorization::Full(station),
                peer: Some(station),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // Cinema: 1 per month.
        if rng.chance(2, 3) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(7, 27)),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 15, 50),
                categorization: Categorization::Full("Кино и театр"),
                peer: Some(rng.pick(CINEMAS)),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // Hobby: 1 per 2-3 months.
        if rng.chance(2, 5) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(5, 28)),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 40, 130),
                categorization: Categorization::Full("Хобби"),
                peer: Some(rng.pick(HOBBIES)),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // Clothes: 1 per 2 months.
        if rng.chance(1, 2) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(7, 27)),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 80, 300),
                categorization: Categorization::Full("Одежда"),
                peer: Some(rng.pick(CLOTHES)),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // Education: 1 per 3 months.
        if rng.chance(1, 3) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(7, 27)),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 50, 200),
                categorization: Categorization::Full("Образование"),
                peer: Some(rng.pick(EDU)),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // ----- Group-level (parent category) tagging -----
        // Real users often tag transactions to a group when no leaf fits or
        // they don't want to be too precise. The report should surface these
        // amounts as the group's own line, distinct from its child leaves.
        // All on Family — these are everyday household expenses.

        // Жильё (group): minor home repair / household supplies.
        if rng.chance(1, 3) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 30, 80),
                categorization: Categorization::Full("Жильё"),
                peer: Some("Хозтовары для дома"),
                bank_description: Some("Мелкий ремонт"),
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // Еда (group): generic food expense not fitting Магазины/Кафе/Доставка.
        if rng.chance(1, 4) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 20, 50),
                categorization: Categorization::Full("Еда"),
                peer: Some("Магазинчик у дома"),
                bank_description: Some("Перекус"),
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // Транспорт (group): parking, tolls.
        if rng.chance(1, 3) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 10, 30),
                categorization: Categorization::Full("Транспорт"),
                peer: Some("Парковка"),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // Здоровье (group): lab tests, supplements.
        if rng.chance(1, 4) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 30, 100),
                categorization: Categorization::Full("Здоровье"),
                peer: Some("Лаборатория"),
                bank_description: Some("Анализы"),
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // Развлечения (group): a one-off event.
        if rng.chance(1, 4) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 20, 80),
                categorization: Categorization::Full("Развлечения"),
                peer: Some("Концерт"),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // Магазины (depth-2 group): generic shopping run.
        if rng.chance(1, 3) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 20, 60),
                categorization: Categorization::Full("Магазины"),
                peer: Some("Магазин у дома"),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // Бензин (depth-2 group): fuel from an unbranded station.
        if rng.chance(1, 4) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 30, 70),
                categorization: Categorization::Full("Бензин"),
                peer: Some("АЗС"),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // Подписки (depth-2 group): bundled family plan.
        if rng.chance(1, 4) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: 0,
                debit_minor: usd_from_range(&mut rng, 10, 25),
                categorization: Categorization::Full("Подписки"),
                peer: Some("Family Plan"),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // ----- Multi-share splits inside one transaction -----
        // Demonstrate group + leaf within the same txn so the user can see
        // both the group's own line and its child line getting their share.
        // All on Family.

        // Hypermarket trip — Магазины (group) + Супермаркеты (leaf descendant).
        if rng.chance(1, 2) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(5, 26)),
                credit_minor: 0,
                debit_minor: multi_total(MULTI_HYPERMARKET),
                categorization: Categorization::Multi(MULTI_HYPERMARKET),
                peer: Some("Гипермаркет"),
                bank_description: Some("Продукты + хозтовары"),
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // Doctor appointment — Врачи (group) + Стоматолог (leaf).
        if rng.chance(1, 4) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(5, 26)),
                credit_minor: 0,
                debit_minor: multi_total(MULTI_DOCTOR_VISIT),
                categorization: Categorization::Multi(MULTI_DOCTOR_VISIT),
                peer: Some("Стоматологическая клиника"),
                bank_description: Some("Консультация + процедура"),
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // Subscription with an add-on — Подписки (group) + Музыка (leaf).
        if rng.chance(1, 3) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(5, 26)),
                credit_minor: 0,
                debit_minor: multi_total(MULTI_SUB_BUNDLE),
                categorization: Categorization::Multi(MULTI_SUB_BUNDLE),
                peer: Some("Family Plan + addon"),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // Two-leaf cross-group split — Супермаркеты + Доставка (different groups).
        if rng.chance(1, 3) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(5, 26)),
                credit_minor: 0,
                debit_minor: multi_total(MULTI_GROCERY_DELIVERY),
                categorization: Categorization::Multi(MULTI_GROCERY_DELIVERY),
                peer: Some("Супермаркет с доставкой"),
                bank_description: Some("Заказ + доставка"),
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // Sporadic Salary → Savings transfer. Placed at the tail of the
        // month so the new rng calls don't shift earlier per-month
        // randomness; the eventual sort_by_date still pins it to day 3 in
        // the chronological order downstream.
        if month_start >= savings_start
            && rng.chance(SAVINGS_TRANSFER_CHANCE_NUM, SAVINGS_TRANSFER_CHANCE_DEN)
        {
            let amount = usd_from_range(
                &mut rng,
                SAVINGS_TRANSFER_LO_USD,
                SAVINGS_TRANSFER_HI_USD,
            );
            let tag_savings = format!("salary->savings@{y}-{m:02}");
            out.push(TxnSpec {
                account: AccountKind::Salary,
                date: safe_date(y, m, 3),
                credit_minor: 0,
                debit_minor: amount,
                categorization: Categorization::None,
                peer: Some("Сберегательный счёт"),
                bank_description: Some("Перевод на сберегательный счёт"),
                transfer_tag: Some(tag_savings.clone()),
                is_correcting: false,
            });
            out.push(TxnSpec {
                account: AccountKind::Savings,
                date: safe_date(y, m, 3),
                credit_minor: amount,
                debit_minor: 0,
                categorization: Categorization::None,
                peer: Some("Зарплатный счёт"),
                bank_description: Some("Перевод с зарплатного счёта"),
                transfer_tag: Some(tag_savings),
                is_correcting: false,
            });
        }

        // Two uncategorized correcting entries seed the dashed-border state
        // for the activity strip. They live on the first two months of the
        // Savings account — typical for the kind of bridging adjustments a
        // user posts when they start tracking an account that already
        // existed at the bank but had a non-zero opening balance, or when
        // they reconcile a small rounding difference after the first
        // import. Day 1 keeps them ahead of any other Savings entry so the
        // running balance is well-defined.
        if month_start == savings_start {
            out.push(TxnSpec {
                account: AccountKind::Savings,
                date: safe_date(y, m, 1),
                credit_minor: usd(250),
                debit_minor: 0,
                categorization: Categorization::None,
                peer: None,
                bank_description: Some("Сверка баланса при старте учёта"),
                transfer_tag: None,
                is_correcting: true,
            });
        }
        if month_start
            == savings_start
                .checked_add_months(Months::new(1))
                .unwrap()
        {
            out.push(TxnSpec {
                account: AccountKind::Savings,
                date: safe_date(y, m, 1),
                credit_minor: 0,
                debit_minor: usd(7),
                categorization: Categorization::None,
                peer: None,
                bank_description: Some("Округление после сверки"),
                transfer_tag: None,
                is_correcting: true,
            });
        }

        // One-shot bachelor-savings dump on the day Savings opens: drain the
        // residual accumulated across the bachelor period into Savings as a
        // single internal transfer. Day 5 keeps it clear of the day-2 family
        // transfer and the day-3 sporadic savings emission. The pair shares
        // a `transfer_tag` so it surfaces in `transaction_links` like every
        // other internal transfer.
        if month_start == savings_start && bachelor_residual_minor > 0 {
            let tag = format!("salary->savings-bachelor@{y}-{m:02}");
            out.push(TxnSpec {
                account: AccountKind::Salary,
                date: safe_date(y, m, 5),
                credit_minor: 0,
                debit_minor: bachelor_residual_minor,
                categorization: Categorization::None,
                peer: Some("Сберегательный счёт"),
                bank_description: Some("Перевод накоплений"),
                transfer_tag: Some(tag.clone()),
                is_correcting: false,
            });
            out.push(TxnSpec {
                account: AccountKind::Savings,
                date: safe_date(y, m, 5),
                credit_minor: bachelor_residual_minor,
                debit_minor: 0,
                categorization: Categorization::None,
                peer: Some("Зарплатный счёт"),
                bank_description: Some("Накопления холостого периода"),
                transfer_tag: Some(tag),
                is_correcting: false,
            });
        }
    }

    // Two illustrative split transactions in the most recent month: half goes
    // to a category, half stays unallocated. Visible in the "last 12 months"
    // demo report so the partial-categorization workflow is obvious. The
    // shopping one lives on Family (it's a household expense), the bonus one
    // on Salary (a partner side-gig payment landing on the salary account).
    let last_month = NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap();
    out.push(TxnSpec {
        account: AccountKind::Family,
        date: safe_date(last_month.year(), last_month.month(), 12),
        credit_minor: 0,
        debit_minor: usd(200),
        categorization: Categorization::Half("Магазины"),
        peer: Some("Гипермаркет"),
        bank_description: Some("Покупка (часть без категории)"),
        transfer_tag: None,
        is_correcting: false,
    });
    out.push(TxnSpec {
        account: AccountKind::Salary,
        date: safe_date(last_month.year(), last_month.month(), 13),
        credit_minor: usd(1_000),
        debit_minor: 0,
        categorization: Categorization::Half("Зарплата"),
        peer: Some("Партнёр"),
        bank_description: Some("Бонус (часть без категории)"),
        transfer_tag: None,
        is_correcting: false,
    });

    // Stable order by date — ties broken by insertion order, which keeps each
    // account's per-day sequence reproducible after the per-account split.
    out.sort_by(|a, b| a.date.cmp(&b.date));
    out
}

// ---- DB write paths ----

fn insert_categories(conn: &Connection) -> rusqlite::Result<HashMap<String, i64>> {
    let mut map = HashMap::new();
    insert_category_tree(conn, INCOME_CATEGORIES, "income", None, &mut map)?;
    insert_category_tree(conn, EXPENSE_CATEGORIES, "expense", None, &mut map)?;
    Ok(map)
}

fn insert_category_tree(
    conn: &Connection,
    specs: &[CategorySpec],
    kind: &str,
    parent_id: Option<i64>,
    map: &mut HashMap<String, i64>,
) -> rusqlite::Result<()> {
    for spec in specs {
        let id = insert_category(conn, spec.name, spec.color, kind, parent_id)?;
        map.insert(spec.name.to_string(), id);
        insert_category_tree(conn, spec.children, kind, Some(id), map)?;
    }
    Ok(())
}

fn insert_category(
    conn: &Connection,
    name: &str,
    color: &str,
    kind: &str,
    parent_id: Option<i64>,
) -> rusqlite::Result<i64> {
    conn.query_row(
        "INSERT INTO categories (name, color, kind, parent_id) VALUES (?1, ?2, ?3, ?4) RETURNING id",
        params![name, color, kind, parent_id],
        |r| r.get(0),
    )
}

fn insert_accounts(conn: &Connection) -> rusqlite::Result<HashMap<AccountKind, i64>> {
    let mut map = HashMap::new();
    for spec in ACCOUNTS {
        let id: i64 = conn.query_row(
            "INSERT INTO accounts (name, bank, currency, account_number, owner_name)
             VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id",
            params![
                spec.name,
                DEMO_ACCOUNT_BANK,
                DEMO_ACCOUNT_CURRENCY,
                spec.account_number,
                DEMO_ACCOUNT_OWNER,
            ],
            |r| r.get(0),
        )?;
        map.insert(spec.kind, id);
    }
    Ok(map)
}

fn insert_batches(
    conn: &Connection,
    accounts: &HashMap<AccountKind, i64>,
    today: NaiveDate,
) -> rusqlite::Result<HashMap<AccountKind, i64>> {
    let imported_at = format!("{}T00:00:00.000Z", today);
    let mut map = HashMap::new();
    for spec in ACCOUNTS {
        let account_id = accounts[&spec.kind];
        let id: i64 = conn.query_row(
            "INSERT INTO import_batches
             (account_id, imported_at, source_filename, row_count, timezone_offset)
             VALUES (?1, ?2, ?3, 0, ?4) RETURNING id",
            params![account_id, imported_at, "demo-seed", DEMO_ACCOUNT_TIMEZONE],
            |r| r.get(0),
        )?;
        map.insert(spec.kind, id);
    }
    Ok(map)
}

fn insert_transactions(
    conn: &Connection,
    account_id: i64,
    batch_id: i64,
    cats: &HashMap<String, i64>,
    txns: &[&TxnSpec],
    transfer_ids: &mut HashMap<String, Vec<i64>>,
) -> rusqlite::Result<()> {
    // Roll a balance scoped to *this* account — the DB stores per-account
    // chains and the import validator checks each chain independently.
    let mut balance: i64 = 0;
    for t in txns {
        balance += t.credit_minor - t.debit_minor;
        // Local noon in the account's timezone, converted to UTC: 12:00 +03:00 = 09:00 UTC.
        let occurred_at_utc = format!("{}T09:00:00.000Z", t.date);
        let txn_id: i64 = conn.query_row(
            "INSERT INTO transactions
             (account_id, import_batch_id, occurred_at_utc, credit, debit, balance,
              peer, bank_description, is_correcting)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING id",
            params![
                account_id,
                batch_id,
                occurred_at_utc,
                t.credit_minor,
                t.debit_minor,
                balance,
                t.peer,
                t.bank_description,
                t.is_correcting as i64,
            ],
            |r| r.get(0),
        )?;
        if let Some(tag) = &t.transfer_tag {
            transfer_ids.entry(tag.clone()).or_default().push(txn_id);
        }

        let total = t.credit_minor + t.debit_minor;
        // Build the list of (category_name, share_minor) entries to insert.
        // Single-share variants degenerate to a one-element list; Multi passes
        // through directly. Skipping zero-share entries keeps the data clean.
        let mut shares: Vec<(&str, i64)> = Vec::new();
        match &t.categorization {
            Categorization::None => {}
            Categorization::Full(name) => {
                if total > 0 {
                    shares.push((name, total));
                }
            }
            Categorization::Half(name) => {
                let s = total / 2;
                if s > 0 {
                    shares.push((name, s));
                }
            }
            Categorization::Multi(parts) => {
                for (name, share) in parts.iter() {
                    if *share > 0 {
                        shares.push((name, *share));
                    }
                }
            }
        }
        for (position, (name, share)) in shares.into_iter().enumerate() {
            let cat_id = cats
                .get(name)
                .copied()
                .unwrap_or_else(|| panic!("seed: unknown category '{name}'"));
            conn.execute(
                "INSERT INTO transaction_categories
                 (transaction_id, category_id, share_minor, position)
                 VALUES (?1, ?2, ?3, ?4)",
                params![txn_id, cat_id, share, position as i64],
            )?;
        }
    }
    Ok(())
}

fn collect_ids(specs: &[CategorySpec], cats: &HashMap<String, i64>, out: &mut Vec<i64>) {
    for spec in specs {
        if let Some(&id) = cats.get(spec.name) {
            out.push(id);
        }
        collect_ids(spec.children, cats, out);
    }
}

fn insert_report_view(
    conn: &Connection,
    accounts: &HashMap<AccountKind, i64>,
    cats: &HashMap<String, i64>,
) -> rusqlite::Result<()> {
    // Include every level (root + children + grandchildren) so the user can
    // fold/unfold the full tree inside the report.
    let mut income_ids: Vec<i64> = Vec::new();
    collect_ids(INCOME_CATEGORIES, cats, &mut income_ids);
    let mut expense_ids: Vec<i64> = Vec::new();
    collect_ids(EXPENSE_CATEGORIES, cats, &mut expense_ids);

    // All three accounts in the demo report — that's the realistic household
    // view. Internal transfers between them surface as paired "Без категории"
    // rows on the income and expense sides which cancel out at the report
    // level; a future "mark internal transfer" feature will hide them.
    let account_ids: Vec<i64> = ACCOUNTS.iter().map(|spec| accounts[&spec.kind]).collect();

    let config = serde_json::json!({
        "version": 1,
        "accountIds": account_ids,
        "expenseCategoryIds": expense_ids,
        "incomeCategoryIds": income_ids,
        "defaultRange": { "kind": "preset", "preset": "last_12_months", "from": null, "to": null },
        "defaultGranularity": "month",
        "defaultCurrency": DEMO_ACCOUNT_CURRENCY,
        "expandedCategoryIds": []
    });
    let config_str = config.to_string();

    conn.execute(
        "INSERT INTO report_views (name, config, sort_order) VALUES (?1, ?2, 0)",
        params![DEMO_REPORT_NAME, config_str],
    )?;
    Ok(())
}

/// Idempotent: ensures the single accounting report exists. Used after every
/// path that may leave the DB without any reports — auto-launch when the user
/// already had data (so the demo seed was skipped) and the manual "clear all
/// data" wipe. Picks up whatever accounts and categories currently live in the
/// DB; if there are none yet, inserts empty arrays so the report tab still
/// shows up and the user can populate it later via the editor.
pub fn ensure_default_report_view(conn: &Connection) -> rusqlite::Result<()> {
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM report_views", [], |r| r.get(0))?;
    if n > 0 {
        return Ok(());
    }

    let account_ids: Vec<i64> = conn
        .prepare("SELECT id FROM accounts ORDER BY id")?
        .query_map([], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<_>>()?;

    let mut income_ids: Vec<i64> = Vec::new();
    let mut expense_ids: Vec<i64> = Vec::new();
    let mut stmt = conn.prepare("SELECT id, kind FROM categories ORDER BY id")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (id, kind) = row?;
        match kind.as_str() {
            "income" => income_ids.push(id),
            "expense" => expense_ids.push(id),
            _ => {}
        }
    }

    let config = serde_json::json!({
        "version": 1,
        "accountIds": account_ids,
        "expenseCategoryIds": expense_ids,
        "incomeCategoryIds": income_ids,
        "defaultRange": { "kind": "preset", "preset": "last_12_months", "from": null, "to": null },
        "defaultGranularity": "month",
        "expandedCategoryIds": []
    });

    conn.execute(
        "INSERT INTO report_views (name, config, sort_order) VALUES (?1, ?2, 0)",
        params![DEMO_REPORT_NAME, config.to_string()],
    )?;
    Ok(())
}

// ---- Public seed/wipe pipeline ----

fn has_user_data(conn: &Connection) -> rusqlite::Result<bool> {
    let n_accounts: i64 = conn.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))?;
    if n_accounts > 0 {
        return Ok(true);
    }
    let n_categories: i64 = conn.query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0))?;
    if n_categories > 0 {
        return Ok(true);
    }
    let n_views: i64 = conn.query_row("SELECT COUNT(*) FROM report_views", [], |r| r.get(0))?;
    Ok(n_views > 0)
}

fn flag_set(conn: &Connection) -> rusqlite::Result<bool> {
    let v: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [DEMO_FLAG_KEY],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v.as_deref() == Some("true"))
}

fn set_flag(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, 'true')
         ON CONFLICT(key) DO UPDATE SET value = 'true'",
        [DEMO_FLAG_KEY],
    )?;
    Ok(())
}

/// Auto-seed entry point. Idempotent: does nothing if the flag is set or the DB
/// already contains anything the user might have created. Always sets the flag
/// at the end so the next launch is a no-op.
pub fn seed_if_first_launch(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    if flag_set(&tx)? {
        return Ok(());
    }
    if has_user_data(&tx)? {
        // Pre-existing data — just remember we're past onboarding so we never
        // overwrite anything later.
        set_flag(&tx)?;
        tx.commit()?;
        return Ok(());
    }
    seed_full(&tx, today_local())?;
    set_flag(&tx)?;
    tx.commit()?;
    Ok(())
}

/// Wipe everything except `app_settings` and `schema_migrations`. Used by both
/// "Load demo data" (before reseeding) and the standalone "Clear all data".
fn wipe(conn: &Connection) -> rusqlite::Result<()> {
    // Order matters even with cascades: explicit deletes are clearer and safer
    // when a single statement spans multiple FK chains.
    conn.execute("DELETE FROM transaction_links", [])?;
    conn.execute("DELETE FROM transaction_categories", [])?;
    conn.execute("DELETE FROM transactions", [])?;
    conn.execute("DELETE FROM import_batches", [])?;
    conn.execute("DELETE FROM accounts", [])?;
    conn.execute("DELETE FROM categories", [])?;
    conn.execute("DELETE FROM report_views", [])?;
    conn.execute("DELETE FROM exchange_rates", [])?;
    Ok(())
}

fn seed_full(conn: &Connection, today: NaiveDate) -> rusqlite::Result<()> {
    let cats = insert_categories(conn)?;
    let accounts = insert_accounts(conn)?;
    let batches = insert_batches(conn, &accounts, today)?;
    let txns = generate_transactions(today);

    // Map of `transfer_tag → [txn_id, txn_id]` for the two halves of every
    // internal transfer. Built up across the per-account passes below and
    // collapsed into transaction_links rows once all txns exist.
    let mut transfer_ids: HashMap<String, Vec<i64>> = HashMap::new();
    // Split the global txn list per account and run a separate balance chain
    // for each. The original sort by date is stable, so each account keeps its
    // own date ordering after the per-kind filter.
    for spec in ACCOUNTS {
        let account_id = accounts[&spec.kind];
        let batch_id = batches[&spec.kind];
        let per_account: Vec<&TxnSpec> = txns.iter().filter(|t| t.account == spec.kind).collect();
        insert_transactions(conn, account_id, batch_id, &cats, &per_account, &mut transfer_ids)?;
    }

    insert_transfer_links(conn, &transfer_ids)?;
    insert_report_view(conn, &accounts, &cats)?;
    Ok(())
}

/// Materialises every collected transfer-tag pair as a `transaction_links`
/// row. Each tag should have collected exactly two ids (one debit side, one
/// credit side); anything else is a programming error in the spec generation.
fn insert_transfer_links(
    conn: &Connection,
    transfer_ids: &HashMap<String, Vec<i64>>,
) -> rusqlite::Result<()> {
    for (tag, ids) in transfer_ids {
        assert_eq!(
            ids.len(),
            2,
            "transfer tag '{tag}' should pair exactly two txns, got {}",
            ids.len()
        );
        let (lo, hi) = if ids[0] < ids[1] {
            (ids[0], ids[1])
        } else {
            (ids[1], ids[0])
        };
        conn.execute(
            "INSERT INTO transaction_links (txn_a_id, txn_b_id) VALUES (?1, ?2)",
            params![lo, hi],
        )?;
    }
    Ok(())
}

fn today_local() -> NaiveDate {
    chrono::Local::now().date_naive()
}

// ---- Tauri commands ----

#[tauri::command]
pub fn seed_demo_data(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
) -> Result<(), String> {
    {
        let conn = state.lock().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        wipe(&tx).map_err(|e| e.to_string())?;
        seed_full(&tx, today_local()).map_err(|e| e.to_string())?;
        set_flag(&tx).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    } // db lock released before we spawn background fetches
    crate::exchange_rates::spawn_missing_rate_downloads(app)?;
    Ok(())
}

#[tauri::command]
pub fn clear_all_data(state: State<'_, DbState>) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    wipe(&tx).map_err(|e| e.to_string())?;
    // Keep the flag set so we don't auto-reseed next launch.
    set_flag(&tx).map_err(|e| e.to_string())?;
    // The accounting report is the sole entry point to the report tab; recreate
    // it (empty) so the user isn't stranded on a missing tab after a wipe.
    ensure_default_report_view(&tx).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use tempfile::TempDir;

    fn open_clean_db() -> (TempDir, Connection) {
        let dir = TempDir::new().unwrap();
        // Use raw open path so we can run seed manually, bypassing the auto hook.
        let conn = Connection::open(dir.path().join("finances.db")).unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        // Apply migrations the same way db::open does.
        crate::db::apply_migrations_for_tests(&conn).unwrap();
        (dir, conn)
    }

    #[test]
    fn seed_creates_account_categories_transactions_and_report() {
        let (_dir, conn) = open_clean_db();
        let today = NaiveDate::from_ymd_opt(2026, 4, 30).unwrap();
        seed_full(&conn, today).unwrap();

        // Four demo accounts — Salary, Family, Savings, Vacation.
        let n_acc: i64 = conn.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0)).unwrap();
        assert_eq!(n_acc, 4);

        // Four matching import batches, one per account.
        let n_batches: i64 = conn
            .query_row("SELECT COUNT(*) FROM import_batches", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_batches, 4);

        // 3 income roots + 6 income (no children) + 8 expense roots + 14 expense
        // children = 3 + 0 children for income roots + 8 expense roots + 14 expense
        // children. Let's just assert it's > 20 — the exact number is structural.
        let n_cats: i64 = conn
            .query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0))
            .unwrap();
        assert!(n_cats > 20, "expected lots of categories, got {n_cats}");

        let n_txns: i64 = conn
            .query_row("SELECT COUNT(*) FROM transactions", [], |r| r.get(0))
            .unwrap();
        // ~1100 base monthly mix + 4 transfer rows per month × 36 months = ~144
        // extra. Bound generously to allow PRNG drift when the mix is tweaked.
        assert!(
            n_txns > 900 && n_txns < 1700,
            "expected ~1250 txns, got {n_txns}"
        );

        // Each month must contribute at least one fully-uncategorized cash
        // withdrawal so the report has a permanent "Без категории" entry.
        // Internal transfers also count — they're uncategorized too — so the
        // bound only grows.
        let n_uncat: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM transactions t
                 WHERE NOT EXISTS (
                     SELECT 1 FROM transaction_categories tc WHERE tc.transaction_id = t.id
                 )",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            n_uncat >= 30,
            "expected at least one uncategorized txn per month (~36+), got {n_uncat}"
        );

        // Multi-share transactions: at least a handful must exist so the
        // report demos the group + leaf split scenario.
        let n_multi_share: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (
                     SELECT transaction_id FROM transaction_categories
                     GROUP BY transaction_id HAVING COUNT(*) > 1
                 )",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            n_multi_share >= 20,
            "expected several multi-share transactions, got {n_multi_share}"
        );

        // And there should be exactly two "half-categorized" rows (one expense, one income)
        // where the linked share is below the transaction total.
        let n_half: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM transactions t
                 JOIN transaction_categories tc ON tc.transaction_id = t.id
                 WHERE tc.share_minor * 2 = t.credit + t.debit",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n_half, 2, "expected exactly two split (50/50) demo rows");

        let n_views: i64 = conn
            .query_row("SELECT COUNT(*) FROM report_views", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_views, 1);

        // Family transfer fires every month (37); vacation fires for the
        // last `VACATION_ACTIVE_MONTHS` (8); savings is sporadic (1-in-3
        // chance over 31 active months — deterministic 10 with seed
        // 0xCAFEBABE) plus a one-shot bachelor-residual dump on the day
        // Savings opens (1). Total: 37 + 8 + 10 + 1 = 56.
        let n_links: i64 = conn
            .query_row("SELECT COUNT(*) FROM transaction_links", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            n_links, 56,
            "expected 37 family + 8 vacation + 10 sporadic savings + 1 bachelor dump transfer pairs, got {n_links}"
        );

        // Every link must connect two transactions on *different* accounts.
        let cross: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM transaction_links l
                 JOIN transactions ta ON ta.id = l.txn_a_id
                 JOIN transactions tb ON tb.id = l.txn_b_id
                 WHERE ta.account_id = tb.account_id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cross, 0, "no link should connect txns on the same account");
    }

    #[test]
    fn seed_distributes_transactions_across_all_accounts() {
        let (_dir, conn) = open_clean_db();
        let today = NaiveDate::from_ymd_opt(2026, 4, 30).unwrap();
        seed_full(&conn, today).unwrap();

        // Each of the four demo accounts must carry transactions; the savings
        // and vacation accounts are intentionally receive-only with one
        // credit per active month.
        let mut stmt = conn
            .prepare(
                "SELECT a.name, COUNT(t.id)
                 FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
                 GROUP BY a.id ORDER BY a.id",
            )
            .unwrap();
        let rows: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();

        let by_name: HashMap<String, i64> = rows.into_iter().collect();
        // Bachelor period: 84 months × 2 (paycheck + uncategorized expense)
        // = 168. Post-family: 37 months × (1 salary + 0..1 quarterly + 2..3
        // transfers + 0..1 misc) ≈ 110-200. Plus 1 half-cat bonus and 1
        // bachelor dump on Salary side. Generous range absorbs PRNG drift.
        let salary = by_name.get("Зарплатный счёт").copied().unwrap_or(0);
        assert!(
            (260..=500).contains(&salary),
            "Зарплатный счёт expected ~280-380 txns, got {salary}"
        );
        // Family carries the lion's share — recurring + variable + groups +
        // multi-splits + monthly transfer-in.
        let family = by_name.get("Семейный счёт").copied().unwrap_or(0);
        assert!(family > 700, "Семейный счёт expected lots of txns, got {family}");
        // Savings: 10 sporadic transfers (1-in-3 chance per active month
        // over 31 months, deterministic with seed 0xCAFEBABE) plus one
        // bachelor-residual dump on the opening day, plus two seeded
        // uncategorized correcting entries on the first two months of the
        // account's life (these drive the dashed-border demo state) → 13.
        let savings = by_name.get("Сберегательный счёт").copied().unwrap_or(0);
        assert_eq!(
            savings, 13,
            "Сберегательный счёт expected 10 sporadic + 1 bachelor dump + 2 correcting = 13 deterministic, got {savings}"
        );
        // Vacation: one transfer-in for each of the active months (8 by
        // default — see VACATION_ACTIVE_MONTHS).
        let vacation = by_name.get("На отпуск").copied().unwrap_or(0);
        assert_eq!(
            vacation, VACATION_ACTIVE_MONTHS as i64,
            "Vacation expected exactly {VACATION_ACTIVE_MONTHS} monthly transfers, got {vacation}"
        );
    }

    #[test]
    fn seed_balance_chain_is_consistent_per_account() {
        let (_dir, conn) = open_clean_db();
        let today = NaiveDate::from_ymd_opt(2026, 4, 30).unwrap();
        seed_full(&conn, today).unwrap();

        // Each account has its own running balance — the import validator
        // checks chains per-account, so the seed must produce them per-account.
        let mut stmt = conn
            .prepare(
                "SELECT account_id, credit, debit, balance FROM transactions
                 ORDER BY account_id ASC, occurred_at_utc ASC, id ASC",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .unwrap();
        let mut current_account: Option<i64> = None;
        let mut prev = 0_i64;
        for r in rows {
            let (account_id, credit, debit, balance) = r.unwrap();
            if current_account != Some(account_id) {
                current_account = Some(account_id);
                prev = 0;
            }
            let expected = prev + credit - debit;
            assert_eq!(
                balance, expected,
                "balance chain broken in account {account_id}"
            );
            // Demo data must never show a negative running balance — opening
            // balance + ordering of paycheck/transfer/expenses is calibrated
            // to keep every account in the black at all times.
            assert!(
                balance >= 0,
                "negative running balance in account {account_id}: {balance}"
            );
            prev = balance;
        }
    }

    #[test]
    fn seed_if_first_launch_skips_when_flag_set() {
        let (_dir, conn) = open_clean_db();
        // Pre-set the flag → no seeding.
        set_flag(&conn).unwrap();
        seed_if_first_launch(&conn).unwrap();
        let n_acc: i64 = conn.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0)).unwrap();
        assert_eq!(n_acc, 0);
    }

    #[test]
    fn seed_if_first_launch_skips_when_user_data_exists() {
        let (_dir, conn) = open_clean_db();
        // Insert one user account. Auto-seed must not overwrite it.
        conn.execute(
            "INSERT INTO accounts (name, bank, currency, account_number, owner_name)
             VALUES ('User', 'B', 'RUB', '1', 'A')",
            [],
        )
        .unwrap();
        seed_if_first_launch(&conn).unwrap();
        let n_acc: i64 = conn.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0)).unwrap();
        assert_eq!(n_acc, 1, "must not have added the demo account");
        // Flag is set so subsequent launches stay no-op even if the user wipes data.
        assert!(flag_set(&conn).unwrap());
    }

    #[test]
    fn seed_if_first_launch_seeds_when_clean_and_flag_absent() {
        let (_dir, conn) = open_clean_db();
        seed_if_first_launch(&conn).unwrap();
        let n_acc: i64 = conn.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0)).unwrap();
        assert_eq!(n_acc, 4);
        assert!(flag_set(&conn).unwrap());
        // Second call must be idempotent.
        seed_if_first_launch(&conn).unwrap();
        let n_acc2: i64 = conn.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0)).unwrap();
        assert_eq!(n_acc2, 4);
    }

    #[test]
    fn wipe_removes_everything_except_settings() {
        let (_dir, conn) = open_clean_db();
        let today = NaiveDate::from_ymd_opt(2026, 4, 30).unwrap();
        seed_full(&conn, today).unwrap();
        set_flag(&conn).unwrap();
        // Add a separate setting to ensure we don't nuke unrelated keys.
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('locale', 'ru')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .unwrap();

        wipe(&conn).unwrap();

        for table in [
            "accounts",
            "transactions",
            "import_batches",
            "transaction_categories",
            "transaction_links",
            "categories",
            "report_views",
            "exchange_rates",
        ] {
            let n: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{table} should be empty after wipe");
        }
        // app_settings must still hold the flag and the locale.
        let n_settings: i64 = conn
            .query_row("SELECT COUNT(*) FROM app_settings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n_settings, 2);
    }

    #[test]
    fn report_view_config_is_valid_json_with_expected_shape() {
        let (_dir, conn) = open_clean_db();
        let today = NaiveDate::from_ymd_opt(2026, 4, 30).unwrap();
        seed_full(&conn, today).unwrap();
        let config: String = conn
            .query_row("SELECT config FROM report_views LIMIT 1", [], |r| r.get(0))
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&config).unwrap();
        assert_eq!(parsed["version"], 1);
        assert_eq!(parsed["defaultGranularity"], "month");
        assert_eq!(parsed["defaultRange"]["preset"], "last_12_months");
        let exp = parsed["expenseCategoryIds"].as_array().unwrap();
        assert!(exp.len() > 10, "expense list should include roots + children");
        let accs = parsed["accountIds"].as_array().unwrap();
        assert_eq!(accs.len(), 4, "demo report must include all four accounts");
    }
}
