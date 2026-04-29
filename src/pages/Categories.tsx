import { FormEvent, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n";
import {
  Category,
  CategoryKind,
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from "../lib/api";
import { buildTree, CategoryNode } from "../lib/category-tree";
import {
  ROOT_PALETTE,
  deriveChildColor,
  nextRootColor,
  shadesOf,
} from "../lib/colors";

const MAX_VISIBLE_DEPTH = 3;

export function CategoriesPage() {
  const t = useT();
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const [creating, setCreating] = useState<{
    kind: CategoryKind;
    parent: Category | null;
  } | null>(null);
  const [editing, setEditing] = useState<Category | null>(null);

  useEffect(() => {
    listCategories()
      .then(setCategories)
      .catch((e) => setError(String(e)));
  }, [version]);

  const refresh = () => setVersion((v) => v + 1);

  const findById = (id: number): Category | null =>
    categories.find((c) => c.id === id) ?? null;

  const usedRootColors = (kind: CategoryKind): string[] =>
    categories.filter((c) => c.kind === kind && c.parentId === null).map((c) => c.color);

  return (
    <section className="page">
      {error && <div className="error">{error}</div>}

      <CategorySection
        kind="income"
        title={t("categories.sectionIncome")}
        nodes={buildTree(categories, "income")}
        onCreateRoot={() => setCreating({ kind: "income", parent: null })}
        onCreateChild={(parent) =>
          setCreating({ kind: "income", parent })
        }
        onEdit={setEditing}
      />

      <CategorySection
        kind="expense"
        title={t("categories.sectionExpense")}
        nodes={buildTree(categories, "expense")}
        onCreateRoot={() => setCreating({ kind: "expense", parent: null })}
        onCreateChild={(parent) =>
          setCreating({ kind: "expense", parent })
        }
        onEdit={setEditing}
      />

      {creating && (
        <CategoryFormModal
          mode="create"
          kind={creating.kind}
          parent={creating.parent}
          parentDepth={
            creating.parent
              ? depthOfCategory(creating.parent, findById)
              : -1
          }
          defaultColor={
            creating.parent
              ? deriveChildColor(
                  creating.parent.color,
                  depthOfCategory(creating.parent, findById) + 1,
                )
              : nextRootColor(usedRootColors(creating.kind))
          }
          onClose={() => setCreating(null)}
          onSaved={() => {
            setCreating(null);
            refresh();
          }}
        />
      )}

      {editing && (
        <CategoryFormModal
          mode="edit"
          category={editing}
          kind={editing.kind}
          parent={editing.parentId ? findById(editing.parentId) : null}
          parentDepth={
            editing.parentId
              ? depthOfCategory(findById(editing.parentId)!, findById)
              : -1
          }
          defaultColor={editing.color}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
          onDeleted={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </section>
  );
}

function depthOfCategory(
  category: Category,
  findById: (id: number) => Category | null,
): number {
  let depth = 0;
  let current: Category | null = category;
  while (current && current.parentId !== null) {
    const parent = findById(current.parentId);
    if (!parent) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

function CategorySection({
  title,
  nodes,
  onCreateRoot,
  onCreateChild,
  onEdit,
}: {
  kind: CategoryKind;
  title: string;
  nodes: CategoryNode[];
  onCreateRoot: () => void;
  onCreateChild: (parent: Category) => void;
  onEdit: (c: Category) => void;
}) {
  const t = useT();
  return (
    <div className="categories-section">
      <header className="categories-section-header">
        <h2>{title}</h2>
        <button type="button" className="btn-primary" onClick={onCreateRoot}>
          {t("categories.createRoot")}
        </button>
      </header>

      {nodes.length === 0 ? (
        <p className="hint">{t("categories.empty")}</p>
      ) : (
        <ul className="categories-tree">
          {nodes.map((node) => (
            <CategoryNodeRow
              key={node.category.id}
              node={node}
              onCreateChild={onCreateChild}
              onEdit={onEdit}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function CategoryNodeRow({
  node,
  onCreateChild,
  onEdit,
}: {
  node: CategoryNode;
  onCreateChild: (parent: Category) => void;
  onEdit: (c: Category) => void;
}) {
  const t = useT();
  const canAddChild = node.depth + 1 < MAX_VISIBLE_DEPTH;

  return (
    <li className="categories-node" data-depth={node.depth}>
      <div className="categories-node-row">
        <span
          className="categories-swatch"
          style={{ backgroundColor: node.category.color }}
          aria-hidden="true"
        />
        <span className="categories-name">{node.category.name}</span>
        <span className="categories-actions">
          {canAddChild && (
            <button
              type="button"
              className="categories-action-btn"
              onClick={() => onCreateChild(node.category)}
              aria-label={t("categories.createChild")}
              title={t("categories.createChild")}
            >
              +
            </button>
          )}
          <button
            type="button"
            className="categories-action-btn"
            onClick={() => onEdit(node.category)}
            aria-label={t("categories.edit")}
            title={t("categories.edit")}
          >
            ✎
          </button>
        </span>
      </div>

      {node.children.length > 0 && (
        <ul className="categories-tree categories-tree--nested">
          {node.children.map((child) => (
            <CategoryNodeRow
              key={child.category.id}
              node={child}
              onCreateChild={onCreateChild}
              onEdit={onEdit}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

type ModalProps =
  | {
      mode: "create";
      kind: CategoryKind;
      parent: Category | null;
      parentDepth: number;
      defaultColor: string;
      onClose: () => void;
      onSaved: () => void;
    }
  | {
      mode: "edit";
      category: Category;
      kind: CategoryKind;
      parent: Category | null;
      parentDepth: number;
      defaultColor: string;
      onClose: () => void;
      onSaved: () => void;
      onDeleted: () => void;
    };

function CategoryFormModal(props: ModalProps) {
  const t = useT();
  const isEdit = props.mode === "edit";

  const [name, setName] = useState<string>(
    isEdit ? props.category.name : "",
  );
  const [color, setColor] = useState<string>(props.defaultColor);
  const [colorTab, setColorTab] = useState<"palette" | "shades">(
    props.parent ? "shades" : "palette",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const childDepth = props.parent ? props.parentDepth + 1 : 0;
  const shades = useMemo(
    () => (props.parent ? shadesOf(props.parent.color, childDepth) : []),
    [props.parent, childDepth],
  );

  const title = isEdit
    ? t("categories.modalEditTitle")
    : props.parent
      ? t("categories.modalCreateChildTitle", { parent: props.parent.name })
      : t("categories.modalCreateTitle");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (isEdit) {
        await updateCategory({ id: props.category.id, name, color });
      } else {
        await createCategory({
          name,
          color,
          kind: props.kind,
          parentId: props.parent?.id ?? null,
        });
      }
      props.onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function onConfirmDelete() {
    if (!isEdit) return;
    setError(null);
    setDeleting(true);
    try {
      await deleteCategory(props.category.id);
      props.onDeleted();
    } catch (e) {
      setError(String(e));
      setDeleting(false);
    }
  }

  const busy = submitting || deleting;

  return createPortal(
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{title}</h3>
          <button
            className="icon-btn"
            onClick={props.onClose}
            aria-label={t("common.close")}
            type="button"
          >
            ×
          </button>
        </header>
        <form onSubmit={onSubmit}>
          <div className="modal-body">
            <div className="account-form account-form--modal">
              <label>
                {t("categories.fieldName")}
                <input
                  required
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("categories.fieldNamePlaceholder")}
                />
              </label>

              <div className="categories-color-field">
                <span className="categories-color-label">
                  {t("categories.fieldColor")}
                </span>

                {props.parent && (
                  <div className="categories-color-tabs">
                    <button
                      type="button"
                      className={
                        colorTab === "shades"
                          ? "categories-color-tab is-active"
                          : "categories-color-tab"
                      }
                      onClick={() => setColorTab("shades")}
                    >
                      {t("categories.colorTabShades")}
                    </button>
                    <button
                      type="button"
                      className={
                        colorTab === "palette"
                          ? "categories-color-tab is-active"
                          : "categories-color-tab"
                      }
                      onClick={() => setColorTab("palette")}
                    >
                      {t("categories.colorTabPalette")}
                    </button>
                  </div>
                )}

                <div className="categories-palette">
                  {(colorTab === "shades" ? shades : ROOT_PALETTE).map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={
                        c.toLowerCase() === color.toLowerCase()
                          ? "categories-swatch-btn is-selected"
                          : "categories-swatch-btn"
                      }
                      style={{ backgroundColor: c }}
                      onClick={() => setColor(c)}
                      aria-label={c}
                    />
                  ))}
                </div>
              </div>
            </div>

            {confirmingDelete && isEdit && (
              <div className="delete-confirm">
                {t("categories.deleteConfirm", { name: props.category.name })}
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
                      : t("categories.deleteConfirmYes")}
                  </button>
                </div>
              </div>
            )}
            {error && <div className="error">{error}</div>}
          </div>
          <footer className="modal-footer">
            {isEdit && (
              <button
                type="button"
                className="btn-danger-ghost modal-footer-left"
                onClick={() => setConfirmingDelete(true)}
                disabled={busy || confirmingDelete}
              >
                {t("categories.delete")}
              </button>
            )}
            <button type="button" className="btn-ghost" onClick={props.onClose}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {submitting ? t("common.saving") : t("common.save")}
            </button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}
