import { useEffect, useMemo, useRef, useState } from "react";

import {
  baseName,
  DocumentModal,
  parseExtraction,
} from "../components/DocumentModal";
import {
  Attachment,
  AttachmentUpload,
  attachmentFileUrl,
  beginAttachmentUpload,
  IngestReport,
  listAttachments,
  listAttachmentUploads,
  uploadAttachmentFile,
} from "../lib/api";
import { useI18n, useT, useTPlural } from "../i18n";

/** Accepted by the file picker; the server re-checks every file by content. */
const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf,.zip,application/zip";

type StatusFilter = "all" | "pending" | "recognised" | "unmatched" | "matched";

function matchesFilter(doc: Attachment, filter: StatusFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "pending":
      return doc.extractStatus === "pending";
    case "recognised":
      return doc.extractStatus === "done" || doc.extractStatus === "partial";
    case "unmatched":
      return doc.transactionId === null;
    case "matched":
      return doc.transactionId !== null;
  }
}

interface UploadProgress {
  fileIndex: number;
  fileCount: number;
  fileName: string;
  sent: number;
  total: number;
}

export function DocumentsPage() {
  const t = useT();
  const tPlural = useTPlural();
  const { locale } = useI18n();
  const [docs, setDocs] = useState<Attachment[]>([]);
  const [uploads, setUploads] = useState<AttachmentUpload[]>([]);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [showHistory, setShowHistory] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [lastReport, setLastReport] = useState<IngestReport | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAttachments(), listAttachmentUploads()])
      .then(([d, u]) => {
        if (cancelled) return;
        setDocs(d);
        setUploads(u);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [version]);

  const refresh = () => setVersion((v) => v + 1);

  const formatDateTime = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });

  const lastUploadLabel = useMemo(() => {
    if (uploads.length === 0) return t("documents.neverUploaded");
    const days = Math.floor(
      (Date.now() - new Date(uploads[0].uploadedAt).getTime()) / 86_400_000,
    );
    const ago = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
      -days,
      "day",
    );
    return t("documents.lastUpload", { when: ago });
  }, [uploads, locale, t]);

  async function uploadFiles(files: File[]) {
    if (files.length === 0 || progress) return;
    setError(null);
    setLastReport(null);
    const sourceName =
      files.length === 1
        ? files[0].name
        : tPlural("documents.filesCount", files.length);
    const total: IngestReport = {
      filesTotal: 0,
      added: 0,
      duplicates: 0,
      skipped: 0,
      skippedNames: [],
    };
    try {
      const uploadId = await beginAttachmentUpload(sourceName);
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setProgress({
          fileIndex: i,
          fileCount: files.length,
          fileName: file.name,
          sent: 0,
          total: file.size,
        });
        const report = await uploadAttachmentFile(uploadId, file, (sent, size) =>
          setProgress((p) => (p ? { ...p, sent, total: size } : p)),
        );
        total.filesTotal += report.filesTotal;
        total.added += report.added;
        total.duplicates += report.duplicates;
        total.skipped += report.skipped;
        total.skippedNames.push(...report.skippedNames);
      }
      setLastReport(total);
    } catch (e) {
      setError(String(e));
    } finally {
      setProgress(null);
      refresh();
    }
  }

  const visible = useMemo(
    () => docs.filter((d) => matchesFilter(d, filter)),
    [docs, filter],
  );

  // Rows grouped by the upload that brought them, newest upload first
  // (the backend already returns them in that order).
  const groups = useMemo(() => {
    const byUpload = new Map<number, Attachment[]>();
    for (const d of visible) {
      const list = byUpload.get(d.uploadId);
      if (list) list.push(d);
      else byUpload.set(d.uploadId, [d]);
    }
    return [...byUpload.entries()];
  }, [visible]);

  const uploadById = useMemo(
    () => new Map(uploads.map((u) => [u.id, u])),
    [uploads],
  );

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: 0,
      pending: 0,
      recognised: 0,
      unmatched: 0,
      matched: 0,
    };
    for (const d of docs) {
      for (const f of Object.keys(c) as StatusFilter[]) {
        if (matchesFilter(d, f)) c[f]++;
      }
    }
    return c;
  }, [docs]);

  const openDoc = openId !== null ? docs.find((d) => d.id === openId) ?? null : null;

  return (
    <section
      className={`page page--documents${dragOver ? " is-drag-over" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void uploadFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="page-toolbar">
        <h2>{t("documents.title")}</h2>
        <span className="hint documents-last-upload">{lastUploadLabel}</span>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setShowHistory((v) => !v)}
          disabled={uploads.length === 0}
        >
          {showHistory ? t("documents.hideHistory") : t("documents.showHistory")}
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => fileInput.current?.click()}
          disabled={progress !== null}
        >
          {t("documents.upload")}
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void uploadFiles(files);
          }}
        />
      </div>

      {error && <div className="error">{error}</div>}

      {progress && (
        <div className="documents-progress">
          <div>
            {t("documents.uploading", {
              index: progress.fileIndex + 1,
              count: progress.fileCount,
              name: progress.fileName,
            })}
            {progress.sent >= progress.total && progress.total > 0 && (
              <span className="hint"> — {t("documents.processing")}</span>
            )}
          </div>
          <progress value={progress.sent} max={progress.total || 1} />
        </div>
      )}

      {lastReport && (
        <div className="documents-report">
          {t("documents.reportSummary", {
            total: lastReport.filesTotal,
            added: lastReport.added,
            duplicates: lastReport.duplicates,
            skipped: lastReport.skipped,
          })}
          {lastReport.skippedNames.length > 0 && (
            <details>
              <summary>{t("documents.reportSkipped")}</summary>
              <ul>
                {lastReport.skippedNames.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </details>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label={t("common.close")}
            onClick={() => setLastReport(null)}
          >
            ×
          </button>
        </div>
      )}

      {showHistory && uploads.length > 0 && (
        <table className="documents-history">
          <thead>
            <tr>
              <th>{t("documents.historyDate")}</th>
              <th>{t("documents.historySource")}</th>
              <th className="num">{t("documents.historyFiles")}</th>
              <th className="num">{t("documents.historyAdded")}</th>
              <th className="num">{t("documents.historyDuplicates")}</th>
              <th className="num">{t("documents.historySkipped")}</th>
            </tr>
          </thead>
          <tbody>
            {uploads.map((u) => (
              <tr key={u.id}>
                <td>{formatDateTime(u.uploadedAt)}</td>
                <td>{u.sourceName ?? "—"}</td>
                <td className="num">{u.filesTotal}</td>
                <td className="num">{u.added}</td>
                <td className="num">{u.duplicates}</td>
                <td className="num">{u.skipped}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {docs.length === 0 ? (
        <div
          className="documents-dropzone"
          onClick={() => fileInput.current?.click()}
        >
          <p>{t("documents.emptyTitle")}</p>
          <p className="hint">{t("documents.emptyHint")}</p>
        </div>
      ) : (
        <>
          <div className="documents-filters">
            {(Object.keys(counts) as StatusFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`documents-filter${filter === f ? " active" : ""}`}
                onClick={() => setFilter(f)}
              >
                {t(`documents.filter.${f}`)} <span className="hint">{counts[f]}</span>
              </button>
            ))}
            <span className="hint documents-drop-hint">{t("documents.dropHint")}</span>
          </div>

          <table className="documents-table">
            <thead>
              <tr>
                <th className="col-thumb" />
                <th>{t("documents.colFile")}</th>
                <th>{t("documents.colStatus")}</th>
                <th>{t("documents.colMemo")}</th>
                <th>{t("documents.colTransaction")}</th>
              </tr>
            </thead>
            {groups.map(([uploadId, rows]) => {
              const upload = uploadById.get(uploadId);
              return (
                <tbody key={uploadId}>
                  <tr className="documents-group">
                    <td colSpan={5}>
                      {upload ? formatDateTime(upload.uploadedAt) : ""}
                      {upload?.sourceName && <> · {upload.sourceName}</>}
                      <span className="hint">
                        {" "}
                        · {tPlural("documents.docsCount", rows.length)}
                      </span>
                    </td>
                  </tr>
                  {rows.map((d) => (
                    <DocumentRow key={d.id} doc={d} onOpen={() => setOpenId(d.id)} />
                  ))}
                </tbody>
              );
            })}
          </table>
        </>
      )}

      {openDoc && (
        <DocumentModal
          doc={openDoc}
          onClose={() => setOpenId(null)}
          onDeleted={() => {
            setOpenId(null);
            refresh();
          }}
          onChanged={refresh}
        />
      )}
    </section>
  );
}

function DocumentRow({ doc, onOpen }: { doc: Attachment; onOpen: () => void }) {
  const t = useT();
  const extraction = parseExtraction(doc.extraction);
  return (
    <tr className="documents-row" onClick={onOpen}>
      <td className="col-thumb">
        {doc.mimeType.startsWith("image/") ? (
          <img src={attachmentFileUrl(doc.id)} alt="" loading="lazy" />
        ) : (
          <span className="documents-thumb-pdf">PDF</span>
        )}
      </td>
      <td className="col-file" title={doc.originalName}>
        {baseName(doc.originalName)}
      </td>
      <td>
        <span className={`documents-status documents-status--${doc.extractStatus}`}>
          {t(`documents.extractStatus.${doc.extractStatus}`)}
        </span>
      </td>
      <td className="col-memo">{extraction?.memo?.value ?? ""}</td>
      <td>
        {doc.transactionId !== null
          ? t(`documents.matchStatus.${doc.matchStatus}`)
          : "—"}
      </td>
    </tr>
  );
}
