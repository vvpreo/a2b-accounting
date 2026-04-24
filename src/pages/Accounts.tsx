import { FormEvent, useEffect, useState } from "react";

import {
  Account,
  createAccount,
  deleteAccount,
  listAccounts,
  updateAccount,
} from "../lib/api";
import { BANK_LIST } from "../lib/banks";
import { CRYPTO_CURRENCIES, FIAT_CURRENCIES } from "../lib/currencies";

interface AccountFormValues {
  name: string;
  bank: string;
  currency: string;
  accountNumber: string;
  ownerName: string;
}

const INITIAL_FORM: AccountFormValues = {
  name: "",
  bank: BANK_LIST[0]?.name ?? "",
  currency: "RUB",
  accountNumber: "",
  ownerName: "",
};

function AccountFields({
  value,
  onChange,
}: {
  value: AccountFormValues;
  onChange: (v: AccountFormValues) => void;
}) {
  return (
    <>
      <label>
        Имя
        <input
          required
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          placeholder="Например, «Зарплатный»"
        />
      </label>
      <label>
        Банк
        <select
          required
          value={value.bank}
          onChange={(e) => onChange({ ...value, bank: e.target.value })}
        >
          {BANK_LIST.map((b) => (
            <option key={b.id} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Валюта
        <select
          required
          value={value.currency}
          onChange={(e) => onChange({ ...value, currency: e.target.value })}
        >
          <optgroup label="Фиатные">
            {FIAT_CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Крипто">
            {CRYPTO_CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <label>
        Номер счёта
        <input
          required
          value={value.accountNumber}
          onChange={(e) =>
            onChange({ ...value, accountNumber: e.target.value })
          }
        />
      </label>
      <label>
        Имя владельца
        <input
          required
          value={value.ownerName}
          onChange={(e) => onChange({ ...value, ownerName: e.target.value })}
        />
      </label>
    </>
  );
}

interface Props {
  onSelectAccount: (id: number) => void;
}

export function AccountsPage({ onSelectAccount }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [form, setForm] = useState<AccountFormValues>(INITIAL_FORM);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);

  async function refresh() {
    setAccounts(await listAccounts());
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, []);

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createAccount(form);
      setForm(INITIAL_FORM);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="page">
      <h2>Счета</h2>

      <form className="account-form" onSubmit={onCreate}>
        <AccountFields value={form} onChange={setForm} />
        <button type="submit" disabled={submitting}>
          {submitting ? "Сохраняю..." : "Завести счёт"}
        </button>
        {error && <div className="error">{error}</div>}
      </form>

      <table className="accounts-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Имя</th>
            <th>Банк</th>
            <th>Валюта</th>
            <th>Номер</th>
            <th>Владелец</th>
            <th>Создан</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {accounts.length === 0 ? (
            <tr>
              <td colSpan={8} className="empty">
                Пока нет счетов.
              </td>
            </tr>
          ) : (
            accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.id}</td>
                <td>{a.name}</td>
                <td>{a.bank}</td>
                <td>{a.currency}</td>
                <td>{a.accountNumber}</td>
                <td>{a.ownerName}</td>
                <td>{a.createdAt}</td>
                <td className="actions-cell">
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => onSelectAccount(a.id)}
                  >
                    Транзакции →
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => setEditing(a)}
                  >
                    Изменить
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {editing && (
        <EditAccountModal
          account={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
          onDeleted={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </section>
  );
}

function EditAccountModal({
  account,
  onClose,
  onSaved,
  onDeleted,
}: {
  account: Account;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [form, setForm] = useState<AccountFormValues>({
    name: account.name,
    bank: account.bank,
    currency: account.currency,
    accountNumber: account.accountNumber,
    ownerName: account.ownerName,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await updateAccount({ id: account.id, ...form });
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function onConfirmDelete() {
    setError(null);
    setDeleting(true);
    try {
      await deleteAccount(account.id);
      onDeleted();
    } catch (e) {
      setError(String(e));
      setDeleting(false);
    }
  }

  const busy = submitting || deleting;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>Редактировать счёт #{account.id}</h3>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label="Закрыть"
            type="button"
          >
            ×
          </button>
        </header>
        <form onSubmit={onSubmit}>
          <div className="modal-body">
            <div className="account-form account-form--modal">
              <AccountFields value={form} onChange={setForm} />
            </div>
            {confirmingDelete && (
              <div className="delete-confirm">
                Удалить счёт «{account.name || account.accountNumber}»?
                Все его транзакции и загрузки будут удалены безвозвратно.
                <div className="delete-confirm-actions">
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={deleting}
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={onConfirmDelete}
                    disabled={deleting}
                  >
                    {deleting ? "Удаляю..." : "Да, удалить"}
                  </button>
                </div>
              </div>
            )}
            {error && <div className="error">{error}</div>}
          </div>
          <footer className="modal-footer">
            <button
              type="button"
              className="btn-danger-ghost modal-footer-left"
              onClick={() => setConfirmingDelete(true)}
              disabled={busy || confirmingDelete}
            >
              Удалить счёт
            </button>
            <button type="button" className="btn-ghost" onClick={onClose}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {submitting ? "Сохраняю..." : "Сохранить"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
