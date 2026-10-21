// Simplifi-style category hierarchy: top-level categories that encompass their
// subcategories (Dining & Drinks › Restaurants). Built from categories.parent_id.

import type { Category, UUID } from '@/types/domain'

/** The top-level ancestor of a category (itself when it has no parent). */
export function rootCategory(cat: Category | null | undefined, byId: Map<UUID, Category>): Category | null {
  let c = cat ?? null
  const seen = new Set<UUID>()
  while (c?.parent_id && !seen.has(c.id)) {
    seen.add(c.id)
    const parent = byId.get(c.parent_id)
    if (!parent) break
    c = parent
  }
  return c
}

/** "Dining & Drinks › Restaurants" for a subcategory, the name for a top-level one. */
export function categoryPath(cat: Category | null | undefined, byId: Map<UUID, Category>, sep = ' › '): string {
  if (!cat) return 'Uncategorized'
  const names: string[] = []
  let c: Category | undefined = cat
  const seen = new Set<UUID>()
  while (c && !seen.has(c.id)) {
    seen.add(c.id)
    names.unshift(c.name)
    c = c.parent_id ? byId.get(c.parent_id) : undefined
  }
  return names.join(sep)
}

export interface CategoryNode {
  category: Category
  depth: number
  children: CategoryNode[]
}

const byOrder = (a: Category, b: Category) =>
  (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name)

/** Top-level categories (by sort order, then name), each with its subtree. */
export function categoryForest(categories: Category[]): CategoryNode[] {
  const ids = new Set(categories.map((c) => c.id))
  const kids = new Map<UUID, Category[]>()
  for (const c of categories) {
    if (c.parent_id && ids.has(c.parent_id)) {
      const list = kids.get(c.parent_id) ?? []
      list.push(c)
      kids.set(c.parent_id, list)
    }
  }
  const build = (c: Category, depth: number): CategoryNode => ({
    category: c,
    depth,
    children: (kids.get(c.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)).map((k) => build(k, depth + 1)),
  })
  return categories
    .filter((c) => !c.parent_id || !ids.has(c.parent_id))
    .sort(byOrder)
    .map((c) => build(c, 0))
}

/** Depth-first flattening of categoryForest — for indented pickers and menus. */
export function flattenForest(forest: CategoryNode[]): { category: Category; depth: number }[] {
  const out: { category: Category; depth: number }[] = []
  const walk = (n: CategoryNode) => {
    out.push({ category: n.category, depth: n.depth })
    n.children.forEach(walk)
  }
  forest.forEach(walk)
  return out
}

/** The user's income category: Simplifi's "Personal Income", the legacy
 *  "Income", else the first top-level income-kind category. */
export function incomeCategory(categories: Category[]): Category | null {
  const top = categories.filter((c) => !c.parent_id)
  return (
    top.find((c) => c.name === 'Personal Income') ??
    top.find((c) => c.name === 'Income') ??
    top.find((c) => c.kind === 'income') ??
    null
  )
}

/** Categories in tree order with an indented label (NBSP-indented so it
 *  survives <option> and menu rendering): "Dining & Drinks", "  Restaurants". */
export function hierarchical(categories: Category[]): { c: Category; label: string }[] {
  return flattenForest(categoryForest(categories.filter((c) => c.is_active !== false))).map(({ category, depth }) => ({
    c: category,
    label: '\u00a0'.repeat(3 * depth) + category.name,
  }))
}
