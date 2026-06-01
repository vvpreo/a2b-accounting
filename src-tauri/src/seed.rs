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
//! groundwork for the multi-currency report. Each account lives in its own
//! currency so the report has to convert across three different bases:
//!   - Salary  ("Зарплатный счёт", EUR): 10 years of history. The earliest
//!     7 years are a "bachelor" period — just one paycheck and one
//!     uncategorized monthly expense, leaving a small residual every month.
//!     After that the Family account opens and the usual transfers (Family /
//!     Savings / Vacation) and small misc spends start.
//!   - Family  ("Семейный счёт", THB): receives the monthly transfer from
//!     Salary (EUR → THB) and occasional gifts; carries the bulk of recurring
//!     life expenses. Opens 36 months ago.
//!   - Savings ("Сберегательный счёт", USD): receive-only, opens 6 months
//!     after the Family account. On that opening day the entire
//!     bachelor-period residual is dumped from Salary (EUR) into Savings (USD)
//!     as a single FX-converted transfer. Subsequent funding is sporadic
//!     (roughly once per quarter) with variable amounts to mimic undisciplined
//!     saving behaviour.
//!   - Vacation ("На отпуск", THB): receive-only, opened ~8 months ago.
//!     Funded by a fixed monthly Salary (EUR) → Vacation (THB) transfer added
//!     on top of the existing transfers — Salary income comfortably covers
//!     it.
//! Transfers between accounts are emitted as paired uncategorized transactions
//! (debit on the source, credit on the destination) so a future feature can
//! link the two sides without changing the schema. When the two sides live in
//! different currencies, the credit amount is the FX-converted value of the
//! debit using the rates listed in the FX section below.

use std::collections::HashMap;

use chrono::{Datelike, Months, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;

use crate::db::DbState;

const DEMO_FLAG_KEY: &str = "demo_seeded";
const DEMO_ACCOUNT_BANK: &str = "Demo Bank";
const DEMO_ACCOUNT_TIMEZONE: &str = "+03:00";
// Default display currency on the seeded report. EUR is the FX base in the
// app and matches the salary account's currency, so the multi-currency demo
// shows a converted view without picking sides between THB and USD.
const DEMO_REPORT_CURRENCY: &str = "EUR";

// ---- Locale ----
//
// Seed text (account names, category names + descriptions, peer/description
// literals on every transaction) is generated in the user's locale so the
// demo dataset can act as a friendly walkthrough of the UI in the language
// the user actually reads. The seed picks up the locale either from
// `app_settings.locale` (set by the frontend after the first language pick),
// or — on the very first launch, before the frontend has had a chance to
// run — by sniffing the OS via `sys-locale` and persisting the result so
// the frontend later agrees with what we baked into the data.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    Ru,
    En,
}

impl Locale {
    fn parse_or_default(value: &str) -> Locale {
        if value.to_ascii_lowercase().starts_with("ru") {
            Locale::Ru
        } else {
            Locale::En
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Locale::Ru => "ru",
            Locale::En => "en",
        }
    }

    fn strings(self) -> &'static SeedStrings {
        match self {
            Locale::Ru => &STRINGS_RU,
            Locale::En => &STRINGS_EN,
        }
    }
}

/// Resolve the locale to seed in. Checks `app_settings.locale` first; if
/// missing, sniffs the OS locale via `sys-locale`; ultimate fallback is
/// English (which also matches the frontend's `DEFAULT_LOCALE`).
fn resolve_locale(conn: &Connection) -> rusqlite::Result<Locale> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'locale'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(value) = stored {
        return Ok(Locale::parse_or_default(&value));
    }
    let os = sys_locale::get_locale().unwrap_or_else(|| "en".to_string());
    Ok(Locale::parse_or_default(&os))
}

/// Persist `locale` into `app_settings.locale` so the frontend boots into
/// the same language we seeded data in. Idempotent — overwrites only when
/// the key is unset, so a user who already picked a language by hand keeps
/// it on subsequent launches.
fn persist_locale_if_unset(conn: &Connection, locale: Locale) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES ('locale', ?1)
         ON CONFLICT(key) DO NOTHING",
        [locale.as_str()],
    )?;
    Ok(())
}

// All user-visible text the seed writes into the database lives here, with
// a Russian and an English flavour. Picked once per seed run based on
// `Locale` and threaded down into the spec/insert pipeline. Keeping these
// as `&'static str` lets `TxnSpec` keep its existing borrowed-string shape.
struct SeedStrings {
    // Account names (one per AccountKind) and bank-account owner.
    account_salary: &'static str,
    account_family: &'static str,
    account_savings: &'static str,
    account_vacation: &'static str,
    account_cash: &'static str,
    account_owner: &'static str,

    // Default demo report.
    report_name: &'static str,

    // Peers (single-string fields used as `Some(s.peer_*)` on TxnSpec).
    peer_employer: &'static str,
    peer_current_expenses: &'static str,
    peer_opening_balance: &'static str,
    peer_parents_transfer: &'static str,
    peer_apartment_rent: &'static str,
    peer_utilities: &'static str,
    peer_isp: &'static str,
    peer_transit_card: &'static str,
    peer_atm: &'static str,
    peer_farmers_market: &'static str,
    peer_clinic: &'static str,
    peer_household_supplies: &'static str,
    peer_corner_store: &'static str,
    peer_parking: &'static str,
    peer_lab: &'static str,
    peer_concert: &'static str,
    peer_neighborhood_store: &'static str,
    peer_no_brand_gas: &'static str,
    peer_family_plan: &'static str,
    peer_hypermarket: &'static str,
    peer_dental_clinic: &'static str,
    peer_family_plan_addon: &'static str,
    peer_supermarket_delivery: &'static str,
    peer_cash: &'static str,
    peer_partner: &'static str,
    /// "АЗС Shell" / "Shell" — used both as the peer string and as the
    /// localised display name of the `fuel.shell` category.
    peer_shell: &'static str,
    peer_bp: &'static str,

    // Free-form descriptions on the bank statement (the column the user sees
    // in the imports table). All optional in the underlying schema — `None`
    // is used in plenty of places where the bank just shows the peer.
    desc_opening_balance: &'static str,
    desc_salary: &'static str,
    desc_monthly_expenses: &'static str,
    desc_quarterly_bonus: &'static str,
    desc_transfer_to_family: &'static str,
    desc_transfer_from_salary: &'static str,
    desc_transfer_to_vacation: &'static str,
    desc_transfer_to_savings: &'static str,
    desc_atm_withdrawal: &'static str,
    desc_atm_withdrawal_candy: &'static str,
    desc_doctor_visit: &'static str,
    desc_minor_repair: &'static str,
    desc_snack: &'static str,
    desc_lab_tests: &'static str,
    desc_hypermarket_run: &'static str,
    desc_consultation_procedure: &'static str,
    desc_delivery_order: &'static str,
    desc_balance_reconciliation: &'static str,
    desc_rounding_adjustment: &'static str,
    desc_savings_transfer: &'static str,
    desc_bachelor_savings: &'static str,
    desc_half_purchase: &'static str,
    desc_half_bonus: &'static str,
    desc_transit_topup: &'static str,

    // RNG-picked peer pools (counterparties on regular spending). The pool
    // contents differ per locale but the count and roles match so the
    // generated transaction stream stays comparable.
    shops: &'static [&'static str],
    cafes: &'static [&'static str],
    delivery: &'static [&'static str],
    taxi: &'static [&'static str],
    pharmacy: &'static [&'static str],
    cinemas: &'static [&'static str],
    subscriptions: &'static [&'static str],
    hobbies: &'static [&'static str],
    clothes: &'static [&'static str],
    edu: &'static [&'static str],
    misc: &'static [&'static str],
}

static STRINGS_RU: SeedStrings = SeedStrings {
    account_salary: "Зарплатный счёт",
    account_family: "Семейный счёт",
    account_savings: "Сберегательный счёт",
    account_vacation: "На отпуск",
    account_cash: "Наличные на конфеты",
    account_owner: "Демо",

    report_name: "Отчёт учёта",

    peer_employer: "ООО \"Работодатель\"",
    peer_current_expenses: "Текущие расходы",
    peer_opening_balance: "Начальный остаток",
    peer_parents_transfer: "Перевод от родителей",
    peer_apartment_rent: "Аренда квартиры",
    peer_utilities: "ЖКХ",
    peer_isp: "Провайдер",
    peer_transit_card: "Транспортная карта",
    peer_atm: "ATM",
    peer_farmers_market: "Фермерский рынок",
    peer_clinic: "Клиника",
    peer_household_supplies: "Хозтовары для дома",
    peer_corner_store: "Магазинчик у дома",
    peer_parking: "Парковка",
    peer_lab: "Лаборатория",
    peer_concert: "Концерт",
    peer_neighborhood_store: "Магазин у дома",
    peer_no_brand_gas: "АЗС",
    peer_family_plan: "Family Plan",
    peer_hypermarket: "Гипермаркет",
    peer_dental_clinic: "Стоматологическая клиника",
    peer_family_plan_addon: "Family Plan + addon",
    peer_supermarket_delivery: "Супермаркет с доставкой",
    peer_cash: "Наличные",
    peer_partner: "Партнёр",
    peer_shell: "АЗС Shell",
    peer_bp: "АЗС BP",

    desc_opening_balance: "Начальный остаток на счёте",
    desc_salary: "Заработная плата",
    desc_monthly_expenses: "Расходы за месяц",
    desc_quarterly_bonus: "Квартальная премия",
    desc_transfer_to_family: "Перевод на семейный счёт",
    desc_transfer_from_salary: "Перевод с зарплатного счёта",
    desc_transfer_to_vacation: "Перевод на отпускной счёт",
    desc_transfer_to_savings: "Перевод на сберегательный счёт",
    desc_atm_withdrawal: "Снятие наличных",
    desc_atm_withdrawal_candy: "Снятие наличных на конфеты",
    desc_doctor_visit: "Приём врача",
    desc_minor_repair: "Мелкий ремонт",
    desc_snack: "Перекус",
    desc_lab_tests: "Анализы",
    desc_hypermarket_run: "Продукты + хозтовары",
    desc_consultation_procedure: "Консультация + процедура",
    desc_delivery_order: "Заказ + доставка",
    desc_balance_reconciliation: "Сверка баланса при старте учёта",
    desc_rounding_adjustment: "Округление после сверки",
    desc_savings_transfer: "Перевод накоплений",
    desc_bachelor_savings: "Накопления холостого периода",
    desc_half_purchase: "Покупка (часть без категории)",
    desc_half_bonus: "Бонус (часть без категории)",
    desc_transit_topup: "Пополнение проездного",

    shops: &["Перекрёсток", "Магнит", "Пятёрочка", "Лента", "Ашан"],
    cafes: &["Кофейня", "Шоколадница", "Кафе у дома", "Coffee House"],
    delivery: &["Яндекс.Еда", "Delivery Club", "Самокат"],
    taxi: &["Яндекс.Такси", "Citymobil"],
    pharmacy: &["Аптека 36.6", "Ригла", "Горздрав"],
    cinemas: &["КиноПоиск", "Каро", "Формула Кино"],
    subscriptions: &["Яндекс.Плюс", "Spotify", "Netflix", "iCloud+"],
    hobbies: &["Спортзал", "Книги", "Игры"],
    clothes: &["Uniqlo", "Zara", "H&M", "Lamoda"],
    edu: &["Курсы английского", "Онлайн-школа", "Книжный магазин"],
    misc: &["Хозтовары", "Подарок", "Сувенир", "Канцелярия"],
};

static STRINGS_EN: SeedStrings = SeedStrings {
    account_salary: "Salary account",
    account_family: "Family account",
    account_savings: "Savings account",
    account_vacation: "Vacation fund",
    account_cash: "Candy cash",
    account_owner: "Demo",

    report_name: "Household report",

    peer_employer: "Acme Corp.",
    peer_current_expenses: "Monthly expenses",
    peer_opening_balance: "Opening balance",
    peer_parents_transfer: "Transfer from parents",
    peer_apartment_rent: "Apartment rent",
    peer_utilities: "Utilities",
    peer_isp: "Internet provider",
    peer_transit_card: "Transit card",
    peer_atm: "ATM",
    peer_farmers_market: "Farmers market",
    peer_clinic: "Clinic",
    peer_household_supplies: "Home supplies",
    peer_corner_store: "Corner store",
    peer_parking: "Parking",
    peer_lab: "Lab",
    peer_concert: "Concert",
    peer_neighborhood_store: "Neighborhood store",
    peer_no_brand_gas: "Gas station",
    peer_family_plan: "Family Plan",
    peer_hypermarket: "Hypermarket",
    peer_dental_clinic: "Dental clinic",
    peer_family_plan_addon: "Family Plan + add-on",
    peer_supermarket_delivery: "Supermarket delivery",
    peer_cash: "Cash",
    peer_partner: "Side project",
    peer_shell: "Shell",
    peer_bp: "BP",

    desc_opening_balance: "Account opening balance",
    desc_salary: "Salary payment",
    desc_monthly_expenses: "Monthly spend",
    desc_quarterly_bonus: "Quarterly bonus",
    desc_transfer_to_family: "Transfer to family account",
    desc_transfer_from_salary: "Transfer from salary account",
    desc_transfer_to_vacation: "Transfer to vacation account",
    desc_transfer_to_savings: "Transfer to savings account",
    desc_atm_withdrawal: "Cash withdrawal",
    desc_atm_withdrawal_candy: "Cash withdrawal for candy",
    desc_doctor_visit: "Doctor visit",
    desc_minor_repair: "Minor repair",
    desc_snack: "Snack",
    desc_lab_tests: "Lab tests",
    desc_hypermarket_run: "Groceries + home supplies",
    desc_consultation_procedure: "Consultation + procedure",
    desc_delivery_order: "Order + delivery",
    desc_balance_reconciliation: "Opening reconciliation",
    desc_rounding_adjustment: "Rounding adjustment",
    desc_savings_transfer: "Savings top-up",
    desc_bachelor_savings: "Pre-family savings deposit",
    desc_half_purchase: "Purchase (partly uncategorised)",
    desc_half_bonus: "Bonus (partly uncategorised)",
    desc_transit_topup: "Transit card top-up",

    shops: &["Whole Foods", "Trader Joe's", "Walmart", "Costco", "Aldi"],
    cafes: &["Blue Bottle", "Starbucks", "Local Cafe", "Coffee House"],
    delivery: &["DoorDash", "Uber Eats", "Instacart"],
    taxi: &["Uber", "Lyft"],
    pharmacy: &["CVS", "Walgreens", "Rite Aid"],
    cinemas: &["AMC", "Regal", "Cinemark"],
    subscriptions: &["Spotify", "YouTube Premium", "Netflix", "iCloud+"],
    hobbies: &["Gym", "Bookstore", "Board games"],
    clothes: &["Uniqlo", "Zara", "H&M", "Gap"],
    edu: &["Language school", "Online course", "Bookstore"],
    misc: &["Home goods", "Gift", "Souvenir", "Stationery"],
};

// ---- FX rates (Frankfurter, 2026-05-05) ----
//
// EUR is the base — that matches what the app's exchange_rates table stores.
// The cross-currency transfers in the seed (Salary EUR → Family THB,
// Salary EUR → Vacation THB, Salary EUR → Savings USD) use these rates to
// derive the destination-side amount from the source-side debit.
//
// Fixed monthly transfers use pre-rounded readable constants (e.g.
// 3 000 EUR ≈ 115 000 THB). The dynamic ones (sporadic Salary→Savings,
// bachelor-residual dump) call `eur_minor_to_usd_minor` so the credit value
// tracks whatever EUR amount the RNG / accumulator produced.
//
//   1 EUR = 1.1686  USD
//   1 EUR = 38.143  THB
//
// Integer math (no f64) keeps the seed fully deterministic across runs and
// platforms; rounding is half-up to the nearest minor unit (scale 2).
fn eur_minor_to_usd_minor(eur_minor: i64) -> i64 {
    (eur_minor * 11686 + 5000) / 10000
}

// ---- Accounts ----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum AccountKind {
    Salary,
    Family,
    Savings,
    Vacation,
    /// Cash purse used to demo the manual-entry account type. THB so transfers
    /// from Family don't need FX conversion.
    Cash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AccountTypeDb {
    Bank,
    Cash,
}

impl AccountTypeDb {
    fn as_str(self) -> &'static str {
        match self {
            AccountTypeDb::Bank => "bank",
            AccountTypeDb::Cash => "cash",
        }
    }
}

struct AccountSpec {
    kind: AccountKind,
    /// Stored in `accounts.account_number`. Empty string is mapped to NULL by
    /// `insert_accounts` so cash accounts don't collide with the partial
    /// unique index on (bank, account_number).
    account_number: &'static str,
    currency: &'static str,
    kind_db: AccountTypeDb,
}

const ACCOUNTS: &[AccountSpec] = &[
    AccountSpec {
        kind: AccountKind::Salary,
        account_number: "DEMO-SAL-0001",
        currency: "EUR",
        kind_db: AccountTypeDb::Bank,
    },
    AccountSpec {
        kind: AccountKind::Family,
        account_number: "DEMO-FAM-0001",
        currency: "THB",
        kind_db: AccountTypeDb::Bank,
    },
    AccountSpec {
        kind: AccountKind::Savings,
        account_number: "DEMO-SAV-0001",
        currency: "USD",
        kind_db: AccountTypeDb::Bank,
    },
    AccountSpec {
        kind: AccountKind::Vacation,
        account_number: "DEMO-VAC-0001",
        currency: "THB",
        kind_db: AccountTypeDb::Bank,
    },
    AccountSpec {
        kind: AccountKind::Cash,
        account_number: "",
        currency: "THB",
        kind_db: AccountTypeDb::Cash,
    },
];

fn account_name(s: &'static SeedStrings, kind: AccountKind) -> &'static str {
    match kind {
        AccountKind::Salary => s.account_salary,
        AccountKind::Family => s.account_family,
        AccountKind::Savings => s.account_savings,
        AccountKind::Vacation => s.account_vacation,
        AccountKind::Cash => s.account_cash,
    }
}

// Fixed monthly internal transfer to Family — kept as plain debits/credits
// with no category so they collapse together in the report's "Без категории"
// line. Salary is in EUR, Family in THB, so the two sides differ in both
// amount and currency; both are pre-rounded to readable demo values that
// approximate the FX conversion (3 000 EUR ≈ 114 429 THB at 38.143).
const TRANSFER_TO_FAMILY_DEBIT_EUR: u32 = 3_000;
const TRANSFER_TO_FAMILY_CREDIT_THB: u32 = 115_000;
// Savings transfers are deliberately irregular: each active month has a
// 1-in-3 chance of a transfer landing, with the amount drawn from a wide
// range. Demos undisciplined saving — sometimes nothing for a few months,
// sometimes back-to-back contributions of varying size. Salary is EUR,
// Savings is USD, so the EUR amount is sampled and the USD credit derived
// via `eur_minor_to_usd_minor`.
const SAVINGS_TRANSFER_CHANCE_NUM: u32 = 1;
const SAVINGS_TRANSFER_CHANCE_DEN: u32 = 3;
const SAVINGS_TRANSFER_LO_EUR: u32 = 430;
const SAVINGS_TRANSFER_HI_EUR: u32 = 1_300;
// The Savings account opens this many months after the Family account.
// Anchor month = `start + SAVINGS_AGE_OFFSET_MONTHS`.
const SAVINGS_AGE_OFFSET_MONTHS: u32 = 6;
// Vacation transfer: a new outflow from Salary (EUR) into Vacation (THB)
// that didn't exist before the account opened. Salary inflow comfortably
// covers the existing transfers plus this one, so adding it doesn't risk
// underflowing any account. Source debit and destination credit are
// pre-rounded around the FX conversion (350 EUR ≈ 13 350 THB).
const TRANSFER_TO_VACATION_DEBIT_EUR: u32 = 350;
const TRANSFER_TO_VACATION_CREDIT_THB: u32 = 13_000;
// Monthly cash withdrawal from the Family (THB) account onto the Cash purse,
// and the candy-purchase mix at 7-Eleven that drains it. Same currency on
// both sides → no FX conversion. The candy purchases live on the Cash
// account, with no `import_batch_id` and a balance auto-computed by the
// running sum (mirrors what the production `create_cash_transaction`
// command does at runtime).
const TRANSFER_TO_CASH_THB: u32 = 2_000;
const CANDY_LO_THB: u32 = 40;
const CANDY_HI_THB: u32 = 180;
const CANDY_RUNS_MIN: u32 = 3;
const CANDY_RUNS_MAX: u32 = 7;
const CANDY_PEER: &str = "7-Eleven";
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
// Bachelor monthly expense range, in EUR (Salary's currency). Tuned so each
// month leaves a few hundred euros of residual on the salary account;
// summed across 84 months this becomes a meaningful one-shot deposit when
// Savings opens (after FX conversion to USD).
const BACHELOR_EXPENSE_LO_EUR: u32 = 3_600;
const BACHELOR_EXPENSE_HI_EUR: u32 = 4_100;
// Separate seed for the bachelor period so its rng calls don't shift the
// existing per-month randomness used by the family/savings/vacation flows.
const BACHELOR_RNG_SEED: u64 = 0xBACE_5EED;
// Same rationale: candy-purchase counts and amounts live on their own RNG
// so adding the cash account didn't reroll any of the existing flows.
const CASH_RNG_SEED: u64 = 0xC0FFEE_CA5;

// Opening balance for the Family account (THB), posted on the first seed day
// so the running balance can absorb month-to-month variance in expenses
// without dipping below zero. Salary and Savings accounts start at zero —
// Salary is continually replenished by the day-1 paycheck, and Savings is
// receive-only.
const OPENING_BALANCE_FAMILY_THB: u32 = 325_000;

// ---- Categories ----

/// A category in the seed tree. `key` is a stable English identifier used
/// throughout the seed code (in `Categorization::Full("salary")`, in the
/// `HashMap<&str, i64>` returned by `insert_categories`, etc.) so that
/// swapping the user-visible language never breaks internal lookups.
struct CategorySpec {
    key: &'static str,
    color: &'static str,
    name_ru: &'static str,
    name_en: &'static str,
    desc_ru: &'static str,
    desc_en: &'static str,
    children: &'static [CategorySpec],
}

impl CategorySpec {
    fn name(&self, locale: Locale) -> &'static str {
        match locale {
            Locale::Ru => self.name_ru,
            Locale::En => self.name_en,
        }
    }
    fn description(&self, locale: Locale) -> &'static str {
        match locale {
            Locale::Ru => self.desc_ru,
            Locale::En => self.desc_en,
        }
    }
}

const INCOME_CATEGORIES: &[CategorySpec] = &[
    CategorySpec {
        key: "salary",
        color: "#84d268",
        name_ru: "Зарплата",
        name_en: "Salary",
        desc_ru: "Регулярные поступления от основного работодателя, включая премии и бонусы.",
        desc_en: "Regular pay from the primary employer, including bonuses.",
        children: &[],
    },
    CategorySpec {
        key: "gifts",
        color: "#d1b07d",
        name_ru: "Подарки",
        name_en: "Gifts",
        desc_ru: "Денежные подарки от родственников и друзей — дни рождения, праздники, помощь.",
        desc_en: "Cash gifts from family and friends — birthdays, holidays, support.",
        children: &[],
    },
    CategorySpec {
        key: "income_misc",
        color: "#5acdc1",
        name_ru: "Прочие доходы",
        name_en: "Other income",
        desc_ru: "Разовые поступления: фриланс, возвраты, кэшбэк и прочее, что не подходит под другие категории.",
        desc_en: "One-off income: freelance, refunds, cashback, anything that doesn't fit elsewhere.",
        children: &[],
    },
];

const EXPENSE_CATEGORIES: &[CategorySpec] = &[
    CategorySpec {
        key: "housing",
        color: "#5a9cc7",
        name_ru: "Жильё",
        name_en: "Housing",
        desc_ru: "Всё, что связано с домом: аренда, коммуналка, интернет, мелкий ремонт и хозтовары.",
        desc_en: "Everything home-related: rent, utilities, internet, small repairs, supplies.",
        children: &[
            CategorySpec {
                key: "rent",
                color: "#7eb1d2",
                name_ru: "Аренда",
                name_en: "Rent",
                desc_ru: "Ежемесячный платёж за съёмное жильё.",
                desc_en: "Monthly rent payment.",
                children: &[],
            },
            CategorySpec {
                key: "utilities",
                color: "#92bcd9",
                name_ru: "Коммуналка",
                name_en: "Utilities",
                desc_ru: "Вода, электричество, газ, отопление, вывоз мусора.",
                desc_en: "Water, electricity, gas, heating, trash.",
                children: &[],
            },
            CategorySpec {
                key: "internet",
                color: "#a6c8df",
                name_ru: "Интернет",
                name_en: "Internet",
                desc_ru: "Домашний интернет и мобильная связь.",
                desc_en: "Home internet and mobile connectivity.",
                children: &[],
            },
        ],
    },
    CategorySpec {
        key: "food",
        color: "#84d268",
        name_ru: "Еда",
        name_en: "Food",
        desc_ru: "Все траты на еду: продукты, кафе, доставка, перекусы.",
        desc_en: "All food spending: groceries, cafes, delivery, snacks.",
        children: &[
            CategorySpec {
                key: "shops",
                color: "#9ddb86",
                name_ru: "Магазины",
                name_en: "Grocery shops",
                desc_ru: "Покупка продуктов в магазинах и на рынке.",
                desc_en: "Groceries at supermarkets and farmers markets.",
                children: &[
                    CategorySpec {
                        key: "supermarkets",
                        color: "#aee29a",
                        name_ru: "Супермаркеты",
                        name_en: "Supermarkets",
                        desc_ru: "Регулярные продуктовые закупки в сетевых супермаркетах.",
                        desc_en: "Regular grocery runs at chain supermarkets.",
                        children: &[],
                    },
                    CategorySpec {
                        key: "farmers_market",
                        color: "#bce8aa",
                        name_ru: "Фермерский рынок",
                        name_en: "Farmers market",
                        desc_ru: "Свежие овощи, фрукты, мясо и молочка с рынка.",
                        desc_en: "Fresh produce, meat and dairy from the market.",
                        children: &[],
                    },
                ],
            },
            CategorySpec {
                key: "cafes",
                color: "#b2e2a4",
                name_ru: "Кафе и рестораны",
                name_en: "Cafes & restaurants",
                desc_ru: "Завтраки, обеды и ужины вне дома, кофе с собой.",
                desc_en: "Eating out and takeaway coffee.",
                children: &[],
            },
            CategorySpec {
                key: "delivery",
                color: "#c2e8b8",
                name_ru: "Доставка",
                name_en: "Food delivery",
                desc_ru: "Доставка готовой еды и продуктов на дом.",
                desc_en: "Prepared meals and groceries delivered home.",
                children: &[],
            },
        ],
    },
    CategorySpec {
        key: "transport",
        color: "#e0b257",
        name_ru: "Транспорт",
        name_en: "Transport",
        desc_ru: "Передвижение по городу и поездки: транспорт, такси, бензин, парковки.",
        desc_en: "Getting around: transit, taxis, fuel, parking.",
        children: &[
            CategorySpec {
                key: "transit",
                color: "#e8c585",
                name_ru: "Общественный",
                name_en: "Public transit",
                desc_ru: "Метро, автобусы, проездные.",
                desc_en: "Subway, buses, transit passes.",
                children: &[],
            },
            CategorySpec {
                key: "taxi",
                color: "#ecce98",
                name_ru: "Такси",
                name_en: "Taxi",
                desc_ru: "Поездки на такси и каршеринг.",
                desc_en: "Ride-hailing and car-sharing trips.",
                children: &[],
            },
            CategorySpec {
                key: "fuel",
                color: "#f0d7ab",
                name_ru: "Бензин",
                name_en: "Fuel",
                desc_ru: "Заправка личного автомобиля.",
                desc_en: "Filling up the personal car.",
                children: &[
                    CategorySpec {
                        key: "fuel_shell",
                        color: "#f5e3c0",
                        name_ru: "АЗС Shell",
                        name_en: "Shell",
                        desc_ru: "Заправки на сети Shell.",
                        desc_en: "Fuel at Shell stations.",
                        children: &[],
                    },
                    CategorySpec {
                        key: "fuel_bp",
                        color: "#f9ecd0",
                        name_ru: "АЗС BP",
                        name_en: "BP",
                        desc_ru: "Заправки на сети BP.",
                        desc_en: "Fuel at BP stations.",
                        children: &[],
                    },
                ],
            },
        ],
    },
    CategorySpec {
        key: "health",
        color: "#e05757",
        name_ru: "Здоровье",
        name_en: "Health",
        desc_ru: "Медицинские траты: лекарства, врачи, анализы, страховка.",
        desc_en: "Medical spending: meds, doctors, lab work, insurance.",
        children: &[
            CategorySpec {
                key: "pharmacy",
                color: "#e88080",
                name_ru: "Аптека",
                name_en: "Pharmacy",
                desc_ru: "Лекарства, БАДы, средства гигиены.",
                desc_en: "Medications, supplements, hygiene products.",
                children: &[],
            },
            CategorySpec {
                key: "doctors",
                color: "#ec9494",
                name_ru: "Врачи",
                name_en: "Doctors",
                desc_ru: "Приёмы у специалистов, процедуры, обследования.",
                desc_en: "Specialist visits, procedures, checkups.",
                children: &[
                    CategorySpec {
                        key: "therapist",
                        color: "#f0a6a6",
                        name_ru: "Терапевт",
                        name_en: "GP",
                        desc_ru: "Приёмы у терапевта и общая диагностика.",
                        desc_en: "GP visits and routine diagnostics.",
                        children: &[],
                    },
                    CategorySpec {
                        key: "dentist",
                        color: "#f4b8b8",
                        name_ru: "Стоматолог",
                        name_en: "Dentist",
                        desc_ru: "Лечение зубов, профчистки, ортодонтия.",
                        desc_en: "Dental treatment, cleanings, orthodontics.",
                        children: &[],
                    },
                ],
            },
        ],
    },
    CategorySpec {
        key: "entertainment",
        color: "#a87dd1",
        name_ru: "Развлечения",
        name_en: "Entertainment",
        desc_ru: "Свободное время: кино, концерты, подписки, хобби.",
        desc_en: "Free-time spending: movies, concerts, subscriptions, hobbies.",
        children: &[
            CategorySpec {
                key: "cinema",
                color: "#b89bd9",
                name_ru: "Кино и театр",
                name_en: "Cinema & theatre",
                desc_ru: "Билеты в кино, театр и на концерты.",
                desc_en: "Tickets to movies, theatre, concerts.",
                children: &[],
            },
            CategorySpec {
                key: "subscriptions",
                color: "#c1abdf",
                name_ru: "Подписки",
                name_en: "Subscriptions",
                desc_ru: "Ежемесячные подписки на сервисы.",
                desc_en: "Recurring service subscriptions.",
                children: &[
                    CategorySpec {
                        key: "music",
                        color: "#cdb9e3",
                        name_ru: "Музыка",
                        name_en: "Music",
                        desc_ru: "Spotify, Яндекс.Музыка и подобное.",
                        desc_en: "Spotify, Apple Music and the like.",
                        children: &[],
                    },
                    CategorySpec {
                        key: "video",
                        color: "#d6c5e8",
                        name_ru: "Видео",
                        name_en: "Video",
                        desc_ru: "Netflix, Кинопоиск и другие видеосервисы.",
                        desc_en: "Netflix, Hulu, and other streaming services.",
                        children: &[],
                    },
                ],
            },
            CategorySpec {
                key: "hobbies",
                color: "#cabae5",
                name_ru: "Хобби",
                name_en: "Hobbies",
                desc_ru: "Спортзал, книги, настольные игры и другие увлечения.",
                desc_en: "Gym, books, board games and other pastimes.",
                children: &[],
            },
        ],
    },
    CategorySpec {
        key: "clothes",
        color: "#d17daf",
        name_ru: "Одежда",
        name_en: "Clothes",
        desc_ru: "Покупка одежды, обуви и аксессуаров.",
        desc_en: "Clothing, shoes and accessories.",
        children: &[],
    },
    CategorySpec {
        key: "education",
        color: "#5acdc1",
        name_ru: "Образование",
        name_en: "Education",
        desc_ru: "Курсы, книги, обучающие материалы.",
        desc_en: "Courses, books, learning materials.",
        children: &[],
    },
    CategorySpec {
        key: "other",
        color: "#7d8ad1",
        name_ru: "Прочее",
        name_en: "Other",
        desc_ru: "Разовые мелкие траты, которые не подходят под другие категории.",
        desc_en: "Small one-offs that don't fit other categories.",
        children: &[],
    },
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

// Splits used by Categorization::Multi. Amounts are in minor units (THB
// satang — Family lives in THB). Each tuple is (category_key, share_minor);
// sum equals the txn debit. Keys map back to `CategorySpec::key`.
const MULTI_HYPERMARKET: &[(&str, i64)] = &[
    ("shops", 1_300_00),           // group: stuff that didn't fit a leaf
    ("supermarkets", 2_900_00),    // leaf: groceries
];
const MULTI_DOCTOR_VISIT: &[(&str, i64)] = &[
    ("doctors", 1_600_00),         // group: consult
    ("dentist", 2_600_00),         // leaf: procedure
];
const MULTI_SUB_BUNDLE: &[(&str, i64)] = &[
    ("subscriptions", 200_00),     // group: base family plan
    ("music", 300_00),             // leaf: add-on
];
const MULTI_GROCERY_DELIVERY: &[(&str, i64)] = &[
    ("supermarkets", 3_300_00),    // leaf under one group
    ("delivery", 800_00),          // leaf under another — cross-group split
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

// Peer pools used by the per-month random walks live on `SeedStrings`
// (`s.shops`, `s.cafes`, ...) so the seed picks names in the user's
// locale. The slices keep the same length and ordering between locales
// so PRNG draws produce comparable distributions either way.

// Each currency we use here has scale 2, so the helpers all share the same
// `× 100` shape; named distinctly to keep the call sites self-documenting
// about which currency a given amount lives in.
fn usd(amount: u32) -> i64 {
    amount as i64 * 100
}
fn eur(amount: u32) -> i64 {
    amount as i64 * 100
}
fn thb(amount: u32) -> i64 {
    amount as i64 * 100
}

fn eur_from_range(rng: &mut Rng, lo: u32, hi: u32) -> i64 {
    eur(rng.range(lo, hi))
}
fn thb_from_range(rng: &mut Rng, lo: u32, hi: u32) -> i64 {
    thb(rng.range(lo, hi))
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

fn generate_transactions(today: NaiveDate, s: &'static SeedStrings) -> Vec<TxnSpec> {
    let mut rng = Rng::new(0xCAFEBABE);
    let mut bachelor_rng = Rng::new(BACHELOR_RNG_SEED);
    let mut cash_rng = Rng::new(CASH_RNG_SEED);
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
        credit_minor: thb(OPENING_BALANCE_FAMILY_THB),
        debit_minor: 0,
        categorization: Categorization::None,
        peer: Some(s.peer_opening_balance),
        bank_description: Some(s.desc_opening_balance),
        transfer_tag: None,
        is_correcting: false,
    });

    // Running total of the bachelor-period residual (paycheck minus monthly
    // expense), in EUR minor units (Salary's currency). Drained into Savings
    // as a single FX-converted transfer on the day Savings opens.
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
                credit_minor: eur(4_300),
                debit_minor: 0,
                categorization: Categorization::Full("salary"),
                peer: Some(s.peer_employer),
                bank_description: Some(s.desc_salary),
                transfer_tag: None,
                is_correcting: false,
            });
            let expense = eur_from_range(
                &mut bachelor_rng,
                BACHELOR_EXPENSE_LO_EUR,
                BACHELOR_EXPENSE_HI_EUR,
            );
            out.push(TxnSpec {
                account: AccountKind::Salary,
                date: safe_date(y, m, 15),
                credit_minor: 0,
                debit_minor: expense,
                categorization: Categorization::None,
                peer: Some(s.peer_current_expenses),
                bank_description: Some(s.desc_monthly_expenses),
                transfer_tag: None,
                is_correcting: false,
            });
            bachelor_residual_minor += eur(4_300) - expense;
            continue;
        }

        // ----- Salary account -----

        // Paycheck on the 1st: 4 300 EUR net. Lands first in the month so the
        // outgoing transfers on day 2 / day 3 always have funds to draw from.
        out.push(TxnSpec {
            account: AccountKind::Salary,
            date: safe_date(y, m, 1),
            credit_minor: eur(4_300),
            debit_minor: 0,
            categorization: Categorization::Full("salary"),
            peer: Some(s.peer_employer),
            bank_description: Some(s.desc_salary),
            transfer_tag: None,
            is_correcting: false,
        });

        // Quarterly bonus on the 25th of Mar/Jun/Sep/Dec.
        if matches!(m, 3 | 6 | 9 | 12) {
            out.push(TxnSpec {
                account: AccountKind::Salary,
                date: safe_date(y, m, 25),
                credit_minor: eur(1_300),
                debit_minor: 0,
                categorization: Categorization::Full("salary"),
                peer: Some(s.peer_employer),
                bank_description: Some(s.desc_quarterly_bonus),
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

        // Day 2: salary (EUR) → family (THB). Same `transfer_tag` on both
        // sides → seeded as a transaction_links row so the demo report
        // excludes the pair as an internal transfer. Debit and credit live in
        // different currencies — the values are pre-rounded around the FX
        // conversion (see TRANSFER_TO_FAMILY_*).
        let tag_family = format!("salary->family@{y}-{m:02}");
        out.push(TxnSpec {
            account: AccountKind::Salary,
            date: safe_date(y, m, 2),
            credit_minor: 0,
            debit_minor: eur(TRANSFER_TO_FAMILY_DEBIT_EUR),
            categorization: Categorization::None,
            peer: Some(s.account_family),
            bank_description: Some(s.desc_transfer_to_family),
            transfer_tag: Some(tag_family.clone()),
            is_correcting: false,
        });
        out.push(TxnSpec {
            account: AccountKind::Family,
            date: safe_date(y, m, 2),
            credit_minor: thb(TRANSFER_TO_FAMILY_CREDIT_THB),
            debit_minor: 0,
            categorization: Categorization::None,
            peer: Some(s.account_salary),
            bank_description: Some(s.desc_transfer_from_salary),
            transfer_tag: Some(tag_family),
            is_correcting: false,
        });

        // (Salary → Savings is now sporadic and emitted at the end of the
        // month loop so its rng calls don't shift the existing per-month
        // randomness for family/multi-split flows.)

        // Day 4: salary (EUR) → vacation (THB). Only emitted while the
        // vacation account is active; before that it didn't exist yet.
        if vacation_active {
            let tag_vacation = format!("salary->vacation@{y}-{m:02}");
            out.push(TxnSpec {
                account: AccountKind::Salary,
                date: safe_date(y, m, 4),
                credit_minor: 0,
                debit_minor: eur(TRANSFER_TO_VACATION_DEBIT_EUR),
                categorization: Categorization::None,
                peer: Some(s.account_vacation),
                bank_description: Some(s.desc_transfer_to_vacation),
                transfer_tag: Some(tag_vacation.clone()),
                is_correcting: false,
            });
            out.push(TxnSpec {
                account: AccountKind::Vacation,
                date: safe_date(y, m, 4),
                credit_minor: thb(TRANSFER_TO_VACATION_CREDIT_THB),
                debit_minor: 0,
                categorization: Categorization::None,
                peer: Some(s.account_salary),
                bank_description: Some(s.desc_transfer_from_salary),
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
                debit_minor: eur_from_range(&mut rng, 10, 60),
                categorization: Categorization::Full("other"),
                peer: Some(rng.pick(s.misc)),
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
                credit_minor: thb_from_range(&mut rng, 1_500, 6_500),
                debit_minor: 0,
                categorization: Categorization::Full("gifts"),
                peer: Some(s.peer_parents_transfer),
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
            debit_minor: thb(65_000),
            categorization: Categorization::Full("rent"),
            peer: Some(s.peer_apartment_rent),
            bank_description: None,
            transfer_tag: None,
            is_correcting: false,
        });
        out.push(TxnSpec {
            account: AccountKind::Family,
            date: safe_date(y, m, 10),
            credit_minor: 0,
            debit_minor: thb_from_range(&mut rng, 3_000, 7_000),
            categorization: Categorization::Full("utilities"),
            peer: Some(s.peer_utilities),
            bank_description: None,
            transfer_tag: None,
            is_correcting: false,
        });
        out.push(TxnSpec {
            account: AccountKind::Family,
            date: safe_date(y, m, 15),
            credit_minor: 0,
            debit_minor: thb(1_000),
            categorization: Categorization::Full("internet"),
            peer: Some(s.peer_isp),
            bank_description: None,
            transfer_tag: None,
            is_correcting: false,
        });
        out.push(TxnSpec {
            account: AccountKind::Family,
            date: safe_date(y, m, 5),
            credit_minor: 0,
            debit_minor: thb(2_500),
            categorization: Categorization::Full("transit"),
            peer: Some(s.peer_transit_card),
            bank_description: Some(s.desc_transit_topup),
            transfer_tag: None,
            is_correcting: false,
        });
        // Subscription rows alternate between "music" and "video" so the
        // grandchild level under "subscriptions" is visible in the demo report.
        let sub_leaf = if rng.chance(1, 2) { "music" } else { "video" };
        out.push(TxnSpec {
            account: AccountKind::Family,
            date: safe_date(y, m, 5),
            credit_minor: 0,
            debit_minor: thb_from_range(&mut rng, 300, 800),
            categorization: Categorization::Full(sub_leaf),
            peer: Some(rng.pick(s.subscriptions)),
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
            debit_minor: thb_from_range(&mut rng, 2_500, 8_000),
            categorization: Categorization::None,
            peer: Some(s.peer_atm),
            bank_description: Some(s.desc_atm_withdrawal),
            transfer_tag: None,
            is_correcting: false,
        });

        // --- Variable groceries: 4 supermarket runs + maybe 1 farmer's market ---
        // Both grandchildren of "shops", which is itself a child of "food".
        for _ in 0..4 {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, days_in_month(y, m))),
                credit_minor: 0,
                debit_minor: thb_from_range(&mut rng, 1_300, 4_900),
                categorization: Categorization::Full("supermarkets"),
                peer: Some(rng.pick(s.shops)),
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
                debit_minor: thb_from_range(&mut rng, 1_000, 3_000),
                categorization: Categorization::Full("farmers_market"),
                peer: Some(s.peer_farmers_market),
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
                debit_minor: thb_from_range(&mut rng, 700, 2_600),
                categorization: Categorization::Full("cafes"),
                peer: Some(rng.pick(s.cafes)),
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
                debit_minor: thb_from_range(&mut rng, 800, 2_300),
                categorization: Categorization::Full("delivery"),
                peer: Some(rng.pick(s.delivery)),
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
                debit_minor: thb_from_range(&mut rng, 300, 1_000),
                categorization: Categorization::Full("taxi"),
                peer: Some(rng.pick(s.taxi)),
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
                debit_minor: thb_from_range(&mut rng, 500, 2_000),
                categorization: Categorization::Full("pharmacy"),
                peer: Some(rng.pick(s.pharmacy)),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // Doctor: roughly every other month — alternating GP / dentist so
        // the third-level grandchild is visible.
        if rng.chance(1, 2) {
            let doctor = if rng.chance(1, 2) { "therapist" } else { "dentist" };
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(5, 28)),
                credit_minor: 0,
                debit_minor: thb_from_range(&mut rng, 2_500, 6_500),
                categorization: Categorization::Full(doctor),
                peer: Some(s.peer_clinic),
                bank_description: Some(s.desc_doctor_visit),
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // Fuel: ~once a month at one of the chains. Exercises the "fuel"
        // grandchildren (Shell / BP).
        if rng.chance(3, 4) {
            let (station_key, station_peer) = if rng.chance(1, 2) {
                ("fuel_shell", s.peer_shell)
            } else {
                ("fuel_bp", s.peer_bp)
            };
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(3, 28)),
                credit_minor: 0,
                debit_minor: thb_from_range(&mut rng, 1_000, 3_000),
                categorization: Categorization::Full(station_key),
                peer: Some(station_peer),
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
                debit_minor: thb_from_range(&mut rng, 500, 1_600),
                categorization: Categorization::Full("cinema"),
                peer: Some(rng.pick(s.cinemas)),
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
                debit_minor: thb_from_range(&mut rng, 1_300, 4_200),
                categorization: Categorization::Full("hobbies"),
                peer: Some(rng.pick(s.hobbies)),
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
                debit_minor: thb_from_range(&mut rng, 2_600, 9_800),
                categorization: Categorization::Full("clothes"),
                peer: Some(rng.pick(s.clothes)),
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
                debit_minor: thb_from_range(&mut rng, 1_600, 6_500),
                categorization: Categorization::Full("education"),
                peer: Some(rng.pick(s.edu)),
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

        // housing (group): minor home repair / household supplies.
        if rng.chance(1, 3) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: 0,
                debit_minor: thb_from_range(&mut rng, 1_000, 2_600),
                categorization: Categorization::Full("housing"),
                peer: Some(s.peer_household_supplies),
                bank_description: Some(s.desc_minor_repair),
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // food (group): generic food expense not fitting shops/cafes/delivery.
        if rng.chance(1, 4) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: 0,
                debit_minor: thb_from_range(&mut rng, 700, 1_600),
                categorization: Categorization::Full("food"),
                peer: Some(s.peer_corner_store),
                bank_description: Some(s.desc_snack),
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // transport (group): parking, tolls.
        if rng.chance(1, 3) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: 0,
                debit_minor: thb_from_range(&mut rng, 300, 1_000),
                categorization: Categorization::Full("transport"),
                peer: Some(s.peer_parking),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // health (group): lab tests, supplements.
        if rng.chance(1, 4) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: 0,
                debit_minor: thb_from_range(&mut rng, 1_000, 3_300),
                categorization: Categorization::Full("health"),
                peer: Some(s.peer_lab),
                bank_description: Some(s.desc_lab_tests),
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // entertainment (group): a one-off event.
        if rng.chance(1, 4) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: 0,
                debit_minor: thb_from_range(&mut rng, 700, 2_600),
                categorization: Categorization::Full("entertainment"),
                peer: Some(s.peer_concert),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // shops (depth-2 group): generic shopping run.
        if rng.chance(1, 3) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: 0,
                debit_minor: thb_from_range(&mut rng, 700, 2_000),
                categorization: Categorization::Full("shops"),
                peer: Some(s.peer_neighborhood_store),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // fuel (depth-2 group): fuel from an unbranded station.
        if rng.chance(1, 4) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: 0,
                debit_minor: thb_from_range(&mut rng, 1_000, 2_300),
                categorization: Categorization::Full("fuel"),
                peer: Some(s.peer_no_brand_gas),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // subscriptions (depth-2 group): bundled family plan.
        if rng.chance(1, 4) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(2, 28)),
                credit_minor: 0,
                debit_minor: thb_from_range(&mut rng, 300, 800),
                categorization: Categorization::Full("subscriptions"),
                peer: Some(s.peer_family_plan),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // ----- Multi-share splits inside one transaction -----
        // Demonstrate group + leaf within the same txn so the user can see
        // both the group's own line and its child line getting their share.
        // All on Family.

        // Hypermarket trip — shops (group) + supermarkets (leaf descendant).
        if rng.chance(1, 2) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(5, 26)),
                credit_minor: 0,
                debit_minor: multi_total(MULTI_HYPERMARKET),
                categorization: Categorization::Multi(MULTI_HYPERMARKET),
                peer: Some(s.peer_hypermarket),
                bank_description: Some(s.desc_hypermarket_run),
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // Doctor appointment — doctors (group) + dentist (leaf).
        if rng.chance(1, 4) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(5, 26)),
                credit_minor: 0,
                debit_minor: multi_total(MULTI_DOCTOR_VISIT),
                categorization: Categorization::Multi(MULTI_DOCTOR_VISIT),
                peer: Some(s.peer_dental_clinic),
                bank_description: Some(s.desc_consultation_procedure),
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // Subscription with an add-on — subscriptions (group) + music (leaf).
        if rng.chance(1, 3) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(5, 26)),
                credit_minor: 0,
                debit_minor: multi_total(MULTI_SUB_BUNDLE),
                categorization: Categorization::Multi(MULTI_SUB_BUNDLE),
                peer: Some(s.peer_family_plan_addon),
                bank_description: None,
                transfer_tag: None,
                is_correcting: false,
            });
        }
        // Two-leaf cross-group split — supermarkets + delivery (different groups).
        if rng.chance(1, 3) {
            out.push(TxnSpec {
                account: AccountKind::Family,
                date: safe_date(y, m, rng.range(5, 26)),
                credit_minor: 0,
                debit_minor: multi_total(MULTI_GROCERY_DELIVERY),
                categorization: Categorization::Multi(MULTI_GROCERY_DELIVERY),
                peer: Some(s.peer_supermarket_delivery),
                bank_description: Some(s.desc_delivery_order),
                transfer_tag: None,
                is_correcting: false,
            });
        }

        // Sporadic Salary (EUR) → Savings (USD) transfer. Placed at the tail
        // of the month so the new rng calls don't shift earlier per-month
        // randomness; the eventual sort_by_date still pins it to day 3 in
        // the chronological order downstream. The salary side debits an EUR
        // amount; the savings side credits the USD equivalent at the fixed
        // demo FX rate.
        if month_start >= savings_start
            && rng.chance(SAVINGS_TRANSFER_CHANCE_NUM, SAVINGS_TRANSFER_CHANCE_DEN)
        {
            let debit_eur = eur_from_range(
                &mut rng,
                SAVINGS_TRANSFER_LO_EUR,
                SAVINGS_TRANSFER_HI_EUR,
            );
            let credit_usd = eur_minor_to_usd_minor(debit_eur);
            let tag_savings = format!("salary->savings@{y}-{m:02}");
            out.push(TxnSpec {
                account: AccountKind::Salary,
                date: safe_date(y, m, 3),
                credit_minor: 0,
                debit_minor: debit_eur,
                categorization: Categorization::None,
                peer: Some(s.account_savings),
                bank_description: Some(s.desc_transfer_to_savings),
                transfer_tag: Some(tag_savings.clone()),
                is_correcting: false,
            });
            out.push(TxnSpec {
                account: AccountKind::Savings,
                date: safe_date(y, m, 3),
                credit_minor: credit_usd,
                debit_minor: 0,
                categorization: Categorization::None,
                peer: Some(s.account_salary),
                bank_description: Some(s.desc_transfer_from_salary),
                transfer_tag: Some(tag_savings),
                is_correcting: false,
            });
        }

        // Two uncategorized correcting entries seed the dashed-border state
        // for the activity strip. They live on the first two months of the
        // Savings (USD) account — typical for the kind of bridging
        // adjustments a user posts when they start tracking an account that
        // already existed at the bank but had a non-zero opening balance, or
        // when they reconcile a small rounding difference after the first
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
                bank_description: Some(s.desc_balance_reconciliation),
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
                bank_description: Some(s.desc_rounding_adjustment),
                transfer_tag: None,
                is_correcting: true,
            });
        }

        // One-shot bachelor-savings dump on the day Savings opens: drain the
        // EUR residual accumulated across the bachelor period out of Salary
        // (EUR) and credit the USD equivalent into Savings (USD) as a single
        // internal transfer. Day 5 keeps it clear of the day-2 family
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
                peer: Some(s.account_savings),
                bank_description: Some(s.desc_savings_transfer),
                transfer_tag: Some(tag.clone()),
                is_correcting: false,
            });
            out.push(TxnSpec {
                account: AccountKind::Savings,
                date: safe_date(y, m, 5),
                credit_minor: eur_minor_to_usd_minor(bachelor_residual_minor),
                debit_minor: 0,
                categorization: Categorization::None,
                peer: Some(s.account_salary),
                bank_description: Some(s.desc_bachelor_savings),
                transfer_tag: Some(tag),
                is_correcting: false,
            });
        }

        // ----- Cash purse (Family → Cash → 7-Eleven) -----
        // Day 6: withdraw a fixed THB amount from the Family account onto the
        // Cash purse. Both sides share a transfer_tag → linked pair in
        // transaction_links. Day 6 sits after the day-4 rent so Family is
        // already topped up. Same currency on both sides → no FX.
        let tag_cash = format!("family->cash@{y}-{m:02}");
        out.push(TxnSpec {
            account: AccountKind::Family,
            date: safe_date(y, m, 6),
            credit_minor: 0,
            debit_minor: thb(TRANSFER_TO_CASH_THB),
            categorization: Categorization::None,
            peer: Some(s.peer_cash),
            bank_description: Some(s.desc_atm_withdrawal_candy),
            transfer_tag: Some(tag_cash.clone()),
            is_correcting: false,
        });
        out.push(TxnSpec {
            account: AccountKind::Cash,
            date: safe_date(y, m, 6),
            credit_minor: thb(TRANSFER_TO_CASH_THB),
            debit_minor: 0,
            categorization: Categorization::None,
            peer: Some(s.account_family),
            bank_description: Some(s.desc_atm_withdrawal),
            transfer_tag: Some(tag_cash),
            is_correcting: false,
        });
        // Spread the candy runs across the rest of the month — small amounts
        // categorised as "supermarkets" (7-Eleven counts as one). Uses a
        // dedicated `cash_rng` so adding this block doesn't reroll the
        // family/savings/vacation flows that share the main `rng`.
        let candy_runs = cash_rng.range(CANDY_RUNS_MIN, CANDY_RUNS_MAX);
        for _ in 0..candy_runs {
            out.push(TxnSpec {
                account: AccountKind::Cash,
                date: safe_date(y, m, cash_rng.range(7, 28)),
                credit_minor: 0,
                debit_minor: thb_from_range(&mut cash_rng, CANDY_LO_THB, CANDY_HI_THB),
                categorization: Categorization::Full("supermarkets"),
                peer: Some(CANDY_PEER),
                bank_description: None,
                transfer_tag: None,
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
        debit_minor: thb(6_500),
        categorization: Categorization::Half("shops"),
        peer: Some(s.peer_hypermarket),
        bank_description: Some(s.desc_half_purchase),
        transfer_tag: None,
        is_correcting: false,
    });
    out.push(TxnSpec {
        account: AccountKind::Salary,
        date: safe_date(last_month.year(), last_month.month(), 13),
        credit_minor: eur(850),
        debit_minor: 0,
        categorization: Categorization::Half("salary"),
        peer: Some(s.peer_partner),
        bank_description: Some(s.desc_half_bonus),
        transfer_tag: None,
        is_correcting: false,
    });

    // Stable order by date — ties broken by insertion order, which keeps each
    // account's per-day sequence reproducible after the per-account split.
    out.sort_by(|a, b| a.date.cmp(&b.date));
    out
}

// ---- DB write paths ----

fn insert_categories(
    conn: &Connection,
    locale: Locale,
) -> rusqlite::Result<HashMap<&'static str, i64>> {
    let mut map = HashMap::new();
    insert_category_tree(conn, INCOME_CATEGORIES, "income", None, locale, &mut map)?;
    insert_category_tree(conn, EXPENSE_CATEGORIES, "expense", None, locale, &mut map)?;
    Ok(map)
}

fn insert_category_tree(
    conn: &Connection,
    specs: &[CategorySpec],
    kind: &str,
    parent_id: Option<i64>,
    locale: Locale,
    map: &mut HashMap<&'static str, i64>,
) -> rusqlite::Result<()> {
    for spec in specs {
        let id = insert_category(
            conn,
            spec.name(locale),
            spec.color,
            kind,
            parent_id,
            Some(spec.description(locale)),
        )?;
        map.insert(spec.key, id);
        insert_category_tree(conn, spec.children, kind, Some(id), locale, map)?;
    }
    Ok(())
}

fn insert_category(
    conn: &Connection,
    name: &str,
    color: &str,
    kind: &str,
    parent_id: Option<i64>,
    description: Option<&str>,
) -> rusqlite::Result<i64> {
    conn.query_row(
        "INSERT INTO categories (name, color, kind, parent_id, description) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id",
        params![name, color, kind, parent_id, description],
        |r| r.get(0),
    )
}

fn insert_accounts(
    conn: &Connection,
    s: &'static SeedStrings,
) -> rusqlite::Result<HashMap<AccountKind, i64>> {
    let mut map = HashMap::new();
    for spec in ACCOUNTS {
        // Cash accounts have no real account number / owner — store NULLs so
        // the partial unique index on (bank, account_number) doesn't have to
        // care, and the UI shows nothing instead of empty strings.
        let acct_no: Option<&str> = if spec.account_number.is_empty() {
            None
        } else {
            Some(spec.account_number)
        };
        let owner: Option<&str> = match spec.kind_db {
            AccountTypeDb::Bank => Some(s.account_owner),
            AccountTypeDb::Cash => None,
        };
        let id: i64 = conn.query_row(
            "INSERT INTO accounts (name, kind, bank, currency, account_number, owner_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id",
            params![
                account_name(s, spec.kind),
                spec.kind_db.as_str(),
                DEMO_ACCOUNT_BANK,
                spec.currency,
                acct_no,
                owner,
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
        // Cash accounts have no import batch — transactions are entered
        // manually and reference `NULL` instead of a batch id.
        if spec.kind_db == AccountTypeDb::Cash {
            continue;
        }
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
    batch_id: Option<i64>,
    cats: &HashMap<&'static str, i64>,
    txns: &[&TxnSpec],
    transfer_ids: &mut HashMap<String, Vec<i64>>,
) -> rusqlite::Result<()> {
    // Roll a balance scoped to *this* account — the DB stores per-account
    // chains and the import validator checks each chain independently. For
    // cash accounts the same running sum mirrors what
    // `cash_transactions::recompute_cash_balances` does at runtime, so the
    // seeded data is indistinguishable from data the user enters manually.
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
        // Build the list of (category_key, share_minor) entries to insert.
        // Keys are stable English identifiers (`CategorySpec::key`) — they
        // map to the per-locale localised name only at category-insert time.
        // Single-share variants degenerate to a one-element list; Multi
        // passes through directly. Zero shares are skipped to keep the data
        // clean.
        let mut shares: Vec<(&str, i64)> = Vec::new();
        match &t.categorization {
            Categorization::None => {}
            Categorization::Full(key) => {
                if total > 0 {
                    shares.push((key, total));
                }
            }
            Categorization::Half(key) => {
                let s = total / 2;
                if s > 0 {
                    shares.push((key, s));
                }
            }
            Categorization::Multi(parts) => {
                for (key, share) in parts.iter() {
                    if *share > 0 {
                        shares.push((key, *share));
                    }
                }
            }
        }
        for (position, (key, share)) in shares.into_iter().enumerate() {
            let cat_id = cats
                .get(key)
                .copied()
                .unwrap_or_else(|| panic!("seed: unknown category key '{key}'"));
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

fn collect_ids(specs: &[CategorySpec], cats: &HashMap<&'static str, i64>, out: &mut Vec<i64>) {
    for spec in specs {
        if let Some(&id) = cats.get(spec.key) {
            out.push(id);
        }
        collect_ids(spec.children, cats, out);
    }
}

fn insert_report_view(
    conn: &Connection,
    accounts: &HashMap<AccountKind, i64>,
    cats: &HashMap<&'static str, i64>,
    s: &'static SeedStrings,
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
        "defaultCurrency": DEMO_REPORT_CURRENCY,
        "expandedCategoryIds": []
    });
    let config_str = config.to_string();

    conn.execute(
        "INSERT INTO report_views (name, config, sort_order) VALUES (?1, ?2, 0)",
        params![s.report_name, config_str],
    )?;
    Ok(())
}

/// Idempotent: ensures the single accounting report exists. Used after every
/// path that may leave the DB without any reports — auto-launch when the user
/// already had data (so the demo seed was skipped) and the manual "clear all
/// data" wipe. Picks up whatever accounts and categories currently live in the
/// DB; if there are none yet, inserts empty arrays so the report tab still
/// shows up and the user can populate it later via the editor. The default
/// report name comes from the current locale stored in `app_settings`.
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

    let locale = resolve_locale(conn)?;
    conn.execute(
        "INSERT INTO report_views (name, config, sort_order) VALUES (?1, ?2, 0)",
        params![locale.strings().report_name, config.to_string()],
    )?;
    Ok(())
}

/// Seed a default AI provider config (OpenRouter, with the API key read from
/// the `OPENROUTER_API_KEY` environment variable) so the provider is usable
/// out of the box without typing credentials in every launch. Idempotent and
/// non-destructive: `INSERT OR IGNORE` only fills the key when it is absent, so
/// a config the user has edited is never overwritten. The actual secret lives
/// in the env var, never in the database.
pub fn ensure_ai_provider_config(conn: &Connection) -> rusqlite::Result<()> {
    let config = serde_json::json!({
        "presetId": "openrouter",
        "baseUrl": "https://openrouter.ai/api/v1",
        "model": "qwen/qwen3-30b-a3b",
        "apiKey": "env:OPENROUTER_API_KEY",
        "temperature": 0
    });
    conn.execute(
        "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('ai_provider_config', ?1)",
        params![config.to_string()],
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
///
/// Locale is resolved from `app_settings.locale` if the user (or a previous
/// run) already picked one; otherwise it's sniffed from the OS via
/// `sys-locale`. The resolved value is persisted to `app_settings.locale` so
/// the frontend boots into the same language we seeded data in.
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
    let locale = resolve_locale(&tx)?;
    seed_full(&tx, today_local(), locale)?;
    persist_locale_if_unset(&tx, locale)?;
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

fn seed_full(conn: &Connection, today: NaiveDate, locale: Locale) -> rusqlite::Result<()> {
    let s = locale.strings();
    let cats = insert_categories(conn, locale)?;
    let accounts = insert_accounts(conn, s)?;
    let batches = insert_batches(conn, &accounts, today)?;
    let txns = generate_transactions(today, s);

    // Map of `transfer_tag → [txn_id, txn_id]` for the two halves of every
    // internal transfer. Built up across the per-account passes below and
    // collapsed into transaction_links rows once all txns exist.
    let mut transfer_ids: HashMap<String, Vec<i64>> = HashMap::new();
    // Split the global txn list per account and run a separate balance chain
    // for each. The original sort by date is stable, so each account keeps its
    // own date ordering after the per-kind filter.
    for spec in ACCOUNTS {
        let account_id = accounts[&spec.kind];
        // Cash accounts have no batch — their transactions reference NULL.
        let batch_id: Option<i64> = batches.get(&spec.kind).copied();
        let per_account: Vec<&TxnSpec> = txns.iter().filter(|t| t.account == spec.kind).collect();
        insert_transactions(conn, account_id, batch_id, &cats, &per_account, &mut transfer_ids)?;
    }

    insert_transfer_links(conn, &transfer_ids)?;
    insert_report_view(conn, &accounts, &cats, s)?;
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
        // Read the locale *before* wipe — wipe leaves app_settings intact,
        // but reading from `tx` keeps the resolution scope tight regardless.
        let locale = resolve_locale(&tx).map_err(|e| e.to_string())?;
        wipe(&tx).map_err(|e| e.to_string())?;
        seed_full(&tx, today_local(), locale).map_err(|e| e.to_string())?;
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
    fn ensure_ai_provider_config_inserts_default_and_is_non_destructive() {
        let (_dir, conn) = open_clean_db();

        // First call inserts the OpenRouter default referencing the env key.
        ensure_ai_provider_config(&conn).unwrap();
        let value: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'ai_provider_config'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(value.contains("env:OPENROUTER_API_KEY"));
        assert!(value.contains("openrouter"));

        // Simulate a user edit, then a second call: must NOT overwrite it.
        conn.execute(
            "UPDATE app_settings SET value = '{\"presetId\":\"custom\"}'
             WHERE key = 'ai_provider_config'",
            [],
        )
        .unwrap();
        ensure_ai_provider_config(&conn).unwrap();
        let after: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'ai_provider_config'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after, "{\"presetId\":\"custom\"}");
    }

    #[test]
    fn seed_creates_account_categories_transactions_and_report() {
        let (_dir, conn) = open_clean_db();
        let today = NaiveDate::from_ymd_opt(2026, 4, 30).unwrap();
        seed_full(&conn, today, Locale::Ru).unwrap();

        // Five demo accounts — Salary, Family, Savings, Vacation, Cash.
        let n_acc: i64 = conn.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0)).unwrap();
        assert_eq!(n_acc, 5);

        // Four matching import batches, one per *bank* account; the cash
        // account has no batch (its rows reference NULL).
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
        // ~1100 base monthly mix + 4 transfer rows per month × 36 months
        // (~144) + cash purse rows (2 transfer + 3..6 candy runs ≈ 7 per
        // month × 36 ≈ 250). Bound generously to absorb PRNG drift.
        assert!(
            n_txns > 1100 && n_txns < 2100,
            "expected ~1500 txns, got {n_txns}"
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
        // Savings opens (1); cash-purse top-up fires every family-active
        // month (37). Total: 37 + 8 + 10 + 1 + 37 = 93.
        let n_links: i64 = conn
            .query_row("SELECT COUNT(*) FROM transaction_links", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            n_links, 93,
            "expected 37 family + 8 vacation + 10 sporadic savings + 1 bachelor dump + 37 cash transfer pairs, got {n_links}"
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
        seed_full(&conn, today, Locale::Ru).unwrap();

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
        // Cash purse: one transfer-in per family-active month (37) plus
        // CANDY_RUNS_MIN..CANDY_RUNS_MAX candy purchases per month — i.e.
        // 37 .. 37 × CANDY_RUNS_MAX. PRNG-driven, so we bracket the range.
        let cash = by_name.get("Наличные на конфеты").copied().unwrap_or(0);
        let cash_lo = FAMILY_AGE_MONTHS as i64 * (1 + CANDY_RUNS_MIN as i64);
        let cash_hi = FAMILY_AGE_MONTHS as i64 * (1 + CANDY_RUNS_MAX as i64);
        assert!(
            (cash_lo..=cash_hi).contains(&cash),
            "Cash account expected between {cash_lo} and {cash_hi} txns, got {cash}"
        );
    }

    #[test]
    fn seed_balance_chain_is_consistent_per_account() {
        let (_dir, conn) = open_clean_db();
        let today = NaiveDate::from_ymd_opt(2026, 4, 30).unwrap();
        seed_full(&conn, today, Locale::Ru).unwrap();

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
        assert_eq!(n_acc, 5);
        assert!(flag_set(&conn).unwrap());
        // Second call must be idempotent.
        seed_if_first_launch(&conn).unwrap();
        let n_acc2: i64 = conn.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0)).unwrap();
        assert_eq!(n_acc2, 5);
    }

    #[test]
    fn wipe_removes_everything_except_settings() {
        let (_dir, conn) = open_clean_db();
        let today = NaiveDate::from_ymd_opt(2026, 4, 30).unwrap();
        seed_full(&conn, today, Locale::Ru).unwrap();
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
        seed_full(&conn, today, Locale::Ru).unwrap();
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
        assert_eq!(accs.len(), 5, "demo report must include all five accounts");
    }

    #[test]
    fn english_seed_writes_english_account_names_and_report_name() {
        let (_dir, conn) = open_clean_db();
        let today = NaiveDate::from_ymd_opt(2026, 4, 30).unwrap();
        seed_full(&conn, today, Locale::En).unwrap();

        // Account names round-trip in the English variant.
        let names: Vec<String> = conn
            .prepare("SELECT name FROM accounts ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(
            names,
            vec![
                "Salary account",
                "Family account",
                "Savings account",
                "Vacation fund",
                "Candy cash",
            ]
        );

        // Report name in English.
        let report: String = conn
            .query_row("SELECT name FROM report_views LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(report, "Household report");

        // A handful of root categories should be in English. Sanity check
        // by counting any row whose name appears in the English seed.
        let income_salary: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM categories WHERE name = ?1 AND kind = 'income'",
                ["Salary"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(income_salary, 1);
    }

    #[test]
    fn english_seed_balance_chain_is_consistent_per_account() {
        // Smoke-check that swapping the locale doesn't break any of the
        // numeric invariants — same balance-chain check the Russian seed
        // is held to, just on the English flavour.
        let (_dir, conn) = open_clean_db();
        let today = NaiveDate::from_ymd_opt(2026, 4, 30).unwrap();
        seed_full(&conn, today, Locale::En).unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT account_id, credit, debit, balance FROM transactions
                 ORDER BY account_id ASC, occurred_at_utc ASC, id ASC",
            )
            .unwrap();
        let rows: Vec<(i64, i64, i64, i64)> = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();

        let mut current_account: Option<i64> = None;
        let mut running: i64 = 0;
        for (account_id, credit, debit, balance) in rows {
            if Some(account_id) != current_account {
                current_account = Some(account_id);
                running = 0;
            }
            running += credit - debit;
            assert_eq!(running, balance, "balance mismatch on account {account_id}");
        }
    }

    #[test]
    fn resolve_locale_prefers_stored_setting() {
        let (_dir, conn) = open_clean_db();
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('locale', 'en')",
            [],
        )
        .unwrap();
        assert_eq!(resolve_locale(&conn).unwrap(), Locale::En);

        conn.execute(
            "UPDATE app_settings SET value = 'ru-RU' WHERE key = 'locale'",
            [],
        )
        .unwrap();
        assert_eq!(resolve_locale(&conn).unwrap(), Locale::Ru);
    }

    #[test]
    fn persist_locale_does_not_overwrite_existing_value() {
        let (_dir, conn) = open_clean_db();
        // User picked English by hand — seed must not clobber it later.
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('locale', 'en')",
            [],
        )
        .unwrap();
        persist_locale_if_unset(&conn, Locale::Ru).unwrap();
        let stored: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'locale'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, "en");
    }

    #[test]
    fn persist_locale_writes_when_unset() {
        let (_dir, conn) = open_clean_db();
        persist_locale_if_unset(&conn, Locale::Ru).unwrap();
        let stored: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'locale'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, "ru");
    }
}
