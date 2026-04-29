import { Category, CategoryKind } from "./api";

export interface CategoryNode {
  category: Category;
  depth: number;
  children: CategoryNode[];
}

export function buildTree(
  categories: Category[],
  kind: CategoryKind,
): CategoryNode[] {
  const filtered = categories.filter((c) => c.kind === kind);
  const byParent = new Map<number | null, Category[]>();
  for (const c of filtered) {
    const key = c.parentId ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(c);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }

  function build(parentId: number | null, depth: number): CategoryNode[] {
    const items = byParent.get(parentId) ?? [];
    return items.map((c) => ({
      category: c,
      depth,
      children: build(c.id, depth + 1),
    }));
  }
  return build(null, 0);
}

// Flatten a tree (depth-first) — useful for filtered/searchable lists.
export function flattenTree(nodes: CategoryNode[]): CategoryNode[] {
  const out: CategoryNode[] = [];
  for (const n of nodes) {
    out.push(n);
    out.push(...flattenTree(n.children));
  }
  return out;
}
