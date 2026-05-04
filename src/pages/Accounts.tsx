import { FormEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useT, useTPlural } from "../i18n";
import {
  Account,
  ImportBatch,
  ValidationError,
  createAccount,
  deleteAccount,
  deleteImportBatch,
  listAccounts,
  listImportBatches,
  updateAccount,
  validateBalanceChain,
} from "../lib/api";
import { ACCOUNT_PRESETS, findPresetByName } from "../lib/account-presets";
import { CRYPTO_CURRENCIES, FIAT_CURRENCIES } from "../lib/currencies";
interface AccountFormValues {
  presetId: string;
  currency: string;
  name: string;
  accountNumber: string;
  ownerName: string;
}

const INITIAL_FORM: AccountFormValues = {
  presetId: ACCOUNT_PRESETS[0].id,
  currency: ACCOUNT_PRESETS[0].defaultCurrency,
  name: "",
  accountNumber: "",
  ownerName: "",
};

function formToApi(form: AccountFormValues): {
  name: string;
  bank: string;
  currency: string;
  accountNumber: string;
  ownerName: string;
} {
  const preset = ACCOUNT_PRESETS.find((p) => p.id === form.presetId);
  return {
    name: form.name,
    bank: preset?.name ?? "",
    currency: form.currency,
    accountNumber: form.accountNumber,
    ownerName: form.ownerName,
  };
}

function AccountFields({
  value,
  onChange,
}: {
  value: AccountFormValues;
  onChange: (v: AccountFormValues) => void;
}) {
  const t = useT();
  return (
    <>
      <label>
        {t("accounts.fieldPreset")}
        <select
          required
          value={value.presetId}
          onChange={(e) => {
            const preset = ACCOUNT_PRESETS.find((p) => p.id === e.target.value);
            onChange({
              ...value,
              presetId: e.target.value,
              currency: preset?.defaultCurrency ?? value.currency,
            });
          }}
        >
          {ACCOUNT_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("accounts.fieldCurrency")}
        <select
          required
          value={value.currency}
          onChange={(e) => onChange({ ...value, currency: e.target.value })}
        >
          <optgroup label={t("accounts.fieldCurrencyFiat")}>
            {FIAT_CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}
              </option>
            ))}
          </optgroup>
          <optgroup label={t("accounts.fieldCurrencyCrypto")}>
            {CRYPTO_CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <label>
        {t("accounts.fieldName")}
        <input
          required
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          placeholder={t("accounts.fieldNamePlaceholder")}
        />
      </label>
      <label>
        {t("accounts.fieldAccountNumberOptional")}
        <input
          value={value.accountNumber}
          onChange={(e) =>
            onChange({ ...value, accountNumber: e.target.value })
          }
        />
      </label>
      <label>
        {t("accounts.fieldOwnerOptional")}
        <input
          value={value.ownerName}
          onChange={(e) => onChange({ ...value, ownerName: e.target.value })}
        />
      </label>
    </>
  );
}

interface Props {
  onCreateAccount: () => void;
  version: number;
}

export function AccountsPage({ onCreateAccount, version }: Props) {
  const t = useT();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [detailAccountId, setDetailAccountId] = useState<number | null>(null);

  async function refresh() {
    setAccounts(await listAccounts());
  }

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, [version]);

  const detailAccount =
    detailAccountId !== null
      ? accounts.find((a) => a.id === detailAccountId) ?? null
      : null;

  return (
    <section className="page">
      {error && <div className="error">{error}</div>}

      <table className="accounts-table">
        <thead>
          <tr>
            <th>{t("accounts.tableId")}</th>
            <th>{t("accounts.tableName")}</th>
            <th>{t("accounts.tableBank")}</th>
            <th>{t("accounts.tableCurrency")}</th>
            <th>{t("accounts.tableNumber")}</th>
            <th>{t("accounts.tableOwner")}</th>
            <th>{t("accounts.tableCreated")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {accounts.length === 0 ? (
            <tr>
              <td colSpan={8} className="empty">
                {t("accounts.empty")}
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
                    onClick={() => setDetailAccountId(a.id)}
                  >
                    {t("accounts.actionDetails")}
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div className="accounts-add-row">
        <button
          type="button"
          className="btn-primary"
          onClick={onCreateAccount}
        >
          {t("accounts.add")}
        </button>
      </div>

      {detailAccount && (
        <AccountDetailModal
          account={detailAccount}
          onClose={() => setDetailAccountId(null)}
          onSaved={async () => {
            await refresh();
          }}
          onDeleted={async () => {
            setDetailAccountId(null);
            await refresh();
          }}
        />
      )}
    </section>
  );
}

type DetailTab = "general" | "batches";

function AccountDetailModal({
  account,
  onClose,
  onSaved,
  onDeleted,
}: {
  account: Account;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const t = useT();
  const [tab, setTab] = useState<DetailTab>("general");

  const [form, setForm] = useState<AccountFormValues>({
    presetId: findPresetByName(account.bank)?.id ?? ACCOUNT_PRESETS[0].id,
    currency: account.currency,
    name: account.name,
    accountNumber: account.accountNumber,
    ownerName: account.ownerName,
  });
  const [submitting, setSubmitting] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setGeneralError(null);
    setSubmitting(true);
    try {
      await updateAccount({ id: account.id, ...formToApi(form) });
      await onSaved();
      onClose();
    } catch (e) {
      setGeneralError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function onConfirmDelete() {
    setGeneralError(null);
    setDeleting(true);
    try {
      await deleteAccount(account.id);
      await onDeleted();
    } catch (e) {
      setGeneralError(String(e));
      setDeleting(false);
    }
  }

  const busy = submitting || deleting;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>
            {account.name} — {account.bank}
            {account.accountNumber ? ` · ${account.accountNumber}` : ""} (
            {account.currency})
          </h3>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
            type="button"
          >
            ×
          </button>
        </header>
        <div className="modal-tabs">
          <button
            type="button"
            className={`modal-tab-button${tab === "general" ? " active" : ""}`}
            onClick={() => setTab("general")}
          >
            {t("accounts.detailsTabGeneral")}
          </button>
          <button
            type="button"
            className={`modal-tab-button${tab === "batches" ? " active" : ""}`}
            onClick={() => setTab("batches")}
          >
            {t("accounts.detailsTabBatches")}
          </button>
        </div>
        {tab === "general" ? (
          <form onSubmit={onSubmit}>
            <div className="modal-body">
              <div className="account-form account-form--modal">
                <AccountFields value={form} onChange={setForm} />
              </div>
              {confirmingDelete && (
                <div className="delete-confirm">
                  {t("accounts.deleteConfirm", {
                    name: account.name || account.accountNumber,
                  })}
                  <div className="delete-confirm-actions">
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={deleting}
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={onConfirmDelete}
                      disabled={deleting}
                    >
                      {deleting
                        ? t("common.deleting")
                        : t("accounts.deleteConfirmYes")}
                    </button>
                  </div>
                </div>
              )}
              {generalError && <div className="error">{generalError}</div>}
            </div>
            <footer className="modal-footer">
              <button
                type="button"
                className="btn-danger-ghost modal-footer-left"
                onClick={() => setConfirmingDelete(true)}
                disabled={busy || confirmingDelete}
              >
                {t("accounts.deleteButton")}
              </button>
              <button type="button" className="btn-ghost" onClick={onClose}>
                {t("common.cancel")}
              </button>
              <button type="submit" className="btn-primary" disabled={busy}>
                {submitting ? t("common.saving") : t("common.save")}
              </button>
            </footer>
          </form>
        ) : (
          <BatchesTab account={account} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function BatchesTab({ account }: { account: Account }) {
  const t = useT();
  const tPlural = useTPlural();
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>(
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [confirmingBatchId, setConfirmingBatchId] = useState<number | null>(
    null,
  );
  const [deletingBatchId, setDeletingBatchId] = useState<number | null>(null);

  async function refresh() {
    try {
      const [b, v] = await Promise.all([
        listImportBatches(account.id),
        validateBalanceChain(account.id),
      ]);
      setBatches(b);
      setValidationErrors(v);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, [account.id]);

  async function onConfirmDeleteBatch(batchId: number) {
    setDeletingBatchId(batchId);
    try {
      await deleteImportBatch(batchId);
      setConfirmingBatchId(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeletingBatchId(null);
    }
  }

  return (
    <div className="modal-body">
      {error && <div className="error">{error}</div>}

      {validationErrors.length === 0 ? (
        <div className="ok">{t("accounts.detailsBalanceChainOk")}</div>
      ) : (
        <div className="validation-warning">
          {tPlural(
            "accounts.detailsBalanceChainBroken",
            validationErrors.length,
          )}
        </div>
      )}

      <aside className="batches-panel batches-panel--full">
        <h3>{t("accounts.detailsBatchesTitle")}</h3>
        {batches.length === 0 ? (
          <p className="empty">{t("accounts.detailsBatchesEmpty")}</p>
        ) : (
          <ul>
            {batches.map((b) => {
              const confirming = confirmingBatchId === b.id;
              const deleting = deletingBatchId === b.id;
              return (
                <li key={b.id}>
                  <div className="batch-time">
                    {formatInstant(b.importedAt)}
                  </div>
                  <div className="batch-filename">
                    {b.sourceFilename ?? "—"}
                  </div>
                  <div className="batch-meta">
                    {tPlural("accounts.detailsBatchRows", b.rowCount)} ·{" "}
                    {t("accounts.detailsBatchTimezone")}{" "}
                    {b.timezoneOffset || "—"}
                  </div>
                  {!confirming ? (
                    <button
                      type="button"
                      className="btn-danger-ghost"
                      onClick={() => setConfirmingBatchId(b.id)}
                    >
                      {t("common.delete")}
                    </button>
                  ) : (
                    <div className="delete-confirm">
                      {t("accounts.detailsBatchDeleteConfirm")}
                      <div className="delete-confirm-actions">
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => setConfirmingBatchId(null)}
                          disabled={deleting}
                        >
                          {t("common.cancel")}
                        </button>
                        <button
                          type="button"
                          className="btn-danger"
                          onClick={() => onConfirmDeleteBatch(b.id)}
                          disabled={deleting}
                        >
                          {deleting
                            ? t("common.deleting")
                            : t("accounts.detailsBatchDeleteYes")}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </aside>
    </div>
  );
}

export function CreateAccountModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useT();
  const [form, setForm] = useState<AccountFormValues>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createAccount(formToApi(form));
      onCreated();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{t("accounts.create")}</h3>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
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
            {error && <div className="error">{error}</div>}
          </div>
          <footer className="modal-footer">
            <button type="button" className="btn-ghost" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? t("common.saving") : t("accounts.create")}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function formatInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 19).replace("T", " ");
}
