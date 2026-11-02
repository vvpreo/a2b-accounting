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
  deleteAttachments,
  finishAttachmentUpload,
  IngestReport,
  listAttachments,
  listAttachmentUploads,
  RECOGNITION_STATUS_EVENT,
  recognitionStatus,
  RecognitionStatus,
  setRecognitionPaused,
  uploadAttachmentFile,
} from "../lib/api";
import { listen } from "../lib/events";
import { rangeIds } from "./transactions/selection";
import { useI18n, useT, useTPlural } from "../i18n";

/** Accepted by the file picker; the server re-checks every file by content. */
const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf,.zip,application/zip";

/** Four independent filters, combined with AND: document time extracted,
 *  OCR passed, linked to a transaction, several candidates. */
type YesNo = "all" | "yes" | "no";
interface Filters {
  time: YesNo;
  ocr: YesNo;
  linked: YesNo;
  ambiguous: "all" | "yes";
}
type FilterKey = keyof Filters;
const FILTER_KEYS: FilterKey[] = ["time", "ocr", "linked", "ambiguous"];
const FILTER_OPTIONS: Record<FilterKey, ("all" | "yes" | "no")[]> = {
  time: ["all", "yes", "no"],
  ocr: ["all", "yes", "no"],
  linked: ["all", "yes", "no"],
  ambiguous: ["all", "yes"],
};
const NO_FILTERS: Filters = { time: "all", ocr: "all", linked: "all", ambiguous: "all" };

/** While the background queue runs, the (large) document list is reloaded
 *  at most this often; it is reloaded once more when the queue empties. */
const QUEUE_REFRESH_MS = 20_000;

/** Whether a document has the property a filter is about. */
function hasProperty(doc: Attachment, key: FilterKey): boolean {
  switch (key) {
    case "time":
      return !!parseExtraction(doc.extraction)?.occurredAt;
    case "ocr":
      return doc.extractStatus !== "pending";
    case "linked":
      return doc.transactionId !== null;
    case "ambiguous":
      return doc.transactionId === null && doc.matchStatus === "ambiguous";
  }
}

function matchesFilters(doc: Attachment, filters: Filters, skip?: FilterKey): boolean {
  return FILTER_KEYS.every((key) => {
    const want = filters[key];
    if (key === skip || want === "all") return true;
    return hasProperty(doc, key) === (want === "yes");
  });
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
  // False until the first list arrives — the list can take a moment, and an
  // empty-state flash before a big list is misleading.
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchorId, setAnchorId] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [uploads, setUploads] = useState<AttachmentUpload[]>([]);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [pausing, setPausing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [lastReport, setLastReport] = useState<IngestReport | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [queue, setQueue] = useState<RecognitionStatus | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastQueueRefresh = useRef(0);

  // Background recognition: progress comes as SSE events; the document list
  // follows it (throttled) so statuses, memos and links show up as they land.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const onStatus = (status: RecognitionStatus) => {
      setQueue(status);
      const now = Date.now();
      if (status.pending === 0 || now - lastQueueRefresh.current > QUEUE_REFRESH_MS) {
        lastQueueRefresh.current = now;
        setVersion((v) => v + 1);
      }
    };
    recognitionStatus()
      .then((s) => !cancelled && setQueue(s))
      .catch(() => {});
    void listen<RecognitionStatus>(RECOGNITION_STATUS_EVENT, (e) => onStatus(e.payload)).then(
      (fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      },
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAttachments(), listAttachmentUploads()])
      .then(([d, u]) => {
        if (cancelled) return;
        setDocs(d);
        setUploads(u);
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoaded(true);
      });
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
    let uploadId: number | null = null;
    try {
      uploadId = await beginAttachmentUpload(sourceName);
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
      // Even after an error: what did arrive gets recognised and linked.
      if (uploadId !== null) {
        await finishAttachmentUpload(uploadId).catch((e) => setError(String(e)));
      }
      setProgress(null);
      refresh();
    }
  }

  const visible = useMemo(
    () => docs.filter((d) => matchesFilters(d, filters)),
    [docs, filters],
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

  // Selection only ever covers visible rows: a bulk delete must never touch
  // something hidden behind a filter.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visibleIds = new Set(visible.map((d) => d.id));
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visible]);

  // Rows in display order (grouped by upload), for Shift+click ranges.
  const orderedIds = useMemo(
    () => groups.flatMap(([, rows]) => rows.map((d) => d.id)),
    [groups],
  );

  function toggleSelect(id: number, shift: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && anchorId !== null) {
        for (const r of rangeIds(orderedIds, anchorId, id)) next.add(r);
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setAnchorId(id);
    setConfirmingDelete(false);
  }

  const allVisibleSelected =
    visible.length > 0 && visible.every((d) => selected.has(d.id));

  function toggleSelectAll() {
    setSelected(allVisibleSelected ? new Set() : new Set(visible.map((d) => d.id)));
    setAnchorId(null);
    setConfirmingDelete(false);
  }

  async function deleteSelected() {
    setDeleting(true);
    setError(null);
    try {
      await deleteAttachments([...selected]);
      setSelected(new Set());
      setAnchorId(null);
      setConfirmingDelete(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(false);
      refresh();
    }
  }

  const uploadById = useMemo(
    () => new Map(uploads.map((u) => [u.id, u])),
    [uploads],
  );

  // Per option: how many documents it would show together with the other
  // three filters as they are set now.
  const counts = useMemo(() => {
    const c = Object.fromEntries(
      FILTER_KEYS.map((k) => [k, { all: 0, yes: 0, no: 0 }]),
    ) as Record<FilterKey, Record<"all" | "yes" | "no", number>>;
    for (const d of docs) {
      for (const key of FILTER_KEYS) {
        if (!matchesFilters(d, filters, key)) continue;
        c[key].all++;
        c[key][hasProperty(d, key) ? "yes" : "no"]++;
      }
    }
    return c;
  }, [docs, filters]);

  async function togglePause() {
    if (!queue) return;
    setPausing(true);
    try {
      setQueue(await setRecognitionPaused(!queue.pausedByUser));
    } catch (e) {
      setError(String(e));
    } finally {
      setPausing(false);
    }
  }

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

      {queue && (queue.pending > 0 || queue.pausedError || queue.pausedByUser || queue.lastLink || queue.ambiguous > 0) && (
        <div className="documents-queue">
          {queue.pausedError ? (
            <div className="error">{t("documents.queue.paused", { error: queue.pausedError })}</div>
          ) : queue.pausedByUser ? (
            <div className="documents-queue-row">
              <span>{t("documents.queue.pausedByUser", { count: queue.pending })}</span>
              <button type="button" className="btn-secondary btn-small" disabled={pausing} onClick={togglePause}>
                {t("documents.queue.resume")}
              </button>
            </div>
          ) : (
            queue.pending > 0 && (
              <div className="documents-queue-row">
                <span>{t("documents.queue.pending", { count: queue.pending })}</span>
                <button
                  type="button"
                  className="btn-secondary btn-small"
                  disabled={pausing}
                  title={t("documents.queue.pauseHint")}
                  onClick={togglePause}
                >
                  {t("documents.queue.pause")}
                </button>
              </div>
            )
          )}
          {queue.lastLink && (
            <div className="hint">{t("documents.queue.linked", { count: queue.lastLink.linked })}</div>
          )}
          {queue.ambiguous > 0 && (
            <div className="hint">{t("documents.queue.ambiguous", { count: queue.ambiguous })}</div>
          )}
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

      {!loaded ? (
        <div className="report-loading">{t("common.loading")}</div>
      ) : docs.length === 0 ? (
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
            {FILTER_KEYS.map((key) => (
              <div key={key} className="documents-filter-group" role="group" aria-label={t(`documents.filter.${key}.label`)}>
                <span className="documents-filter-label">{t(`documents.filter.${key}.label`)}</span>
                {FILTER_OPTIONS[key].map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    className={`documents-filter${filters[key] === opt ? " active" : ""}`}
                    onClick={() => setFilters((f) => ({ ...f, [key]: opt }))}
                  >
                    {t(`documents.filter.${key}.${opt}`)} <span className="hint">{counts[key][opt]}</span>
                  </button>
                ))}
              </div>
            ))}
            <span className="hint documents-drop-hint">{t("documents.dropHint")}</span>
          </div>

          {selected.size > 0 && (
            <div className="documents-selection">
              <span>{t("documents.selection.count", { count: selected.size })}</span>
              <button
                type="button"
                className="btn-danger btn-small"
                onClick={() => setConfirmingDelete(true)}
                disabled={deleting || confirmingDelete}
              >
                {t("documents.selection.delete")}
              </button>
              <button
                type="button"
                className="btn-ghost btn-small"
                onClick={() => {
                  setSelected(new Set());
                  setAnchorId(null);
                  setConfirmingDelete(false);
                }}
                disabled={deleting}
              >
                {t("documents.selection.clear")}
              </button>
              {confirmingDelete && (
                <div className="danger-confirm">
                  <p>{t("documents.selection.confirm", { count: selected.size })}</p>
                  <div className="danger-confirm-actions">
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={() => void deleteSelected()}
                      disabled={deleting}
                    >
                      {deleting ? t("common.deleting") : t("common.delete")}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => setConfirmingDelete(false)}
                      disabled={deleting}
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <table className="documents-table">
            <thead>
              <tr>
                <th className="col-select">
                  <input
                    type="checkbox"
                    aria-label={t("documents.selection.all")}
                    title={t("documents.selection.all")}
                    checked={allVisibleSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = !allVisibleSelected && selected.size > 0;
                    }}
                    onChange={toggleSelectAll}
                  />
                </th>
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
                    <td colSpan={6}>
                      {upload ? formatDateTime(upload.uploadedAt) : ""}
                      {upload?.sourceName && <> · {upload.sourceName}</>}
                      <span className="hint">
                        {" "}
                        · {tPlural("documents.docsCount", rows.length)}
                      </span>
                    </td>
                  </tr>
                  {rows.map((d) => (
                    <DocumentRow
                      key={d.id}
                      doc={d}
                      selected={selected.has(d.id)}
                      onToggle={(shift) => toggleSelect(d.id, shift)}
                      onOpen={() => setOpenId(d.id)}
                    />
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

function DocumentRow({
  doc,
  selected,
  onToggle,
  onOpen,
}: {
  doc: Attachment;
  selected: boolean;
  /** `shift` — Shift+click: select the range from the previous click. */
  onToggle: (shift: boolean) => void;
  onOpen: () => void;
}) {
  const t = useT();
  const extraction = parseExtraction(doc.extraction);
  return (
    <tr className={`documents-row${selected ? " is-selected" : ""}`} onClick={onOpen}>
      <td
        className="col-select"
        onClick={(e) => {
          // The whole cell is the hit area; it never opens the document.
          e.stopPropagation();
          onToggle(e.shiftKey);
        }}
      >
        <input type="checkbox" checked={selected} readOnly tabIndex={-1} />
      </td>
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
