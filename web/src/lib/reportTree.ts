// Collapsible report tree (Simplifi's "Expense transactions by category" table):
//   Expenses
//     ▾ Group / parent category
//         ▾ Category
//             transaction rows
//           Total Category
//       Total Group
// Hierarchy comes from category_groups (group_id) and categories.parent_id chains.
// A transaction posted directly on a category that also has children lands in a
// "<Parent> (Other)" child, exactly as Simplifi names it.

import { reportFlow, type ReportFlow } from '@/lib/reports'
import type { Category, CategoryGroup, Transaction, UUID } from '@/types/domain'

export interface TreeNode {
  id: string
  label: string
  /** Net flow total of everything beneath this node. */
  total: number
  children: TreeNode[]
  txns: Transaction[]
  color?: string
}

const UNCATEGORIZED = '__uncategorized__'

function ancestry(cat: Category, byId: Map<UUID, Category>): Category[] {
  const chain: Category[] = []
  const seen = new Set<UUID>()
  let c: Category | undefined = cat
  while (c && !seen.has(c.id)) {
    seen.add(c.id)
    chain.unshift(c)
    c = c.parent_id ? byId.get(c.parent_id) : undefined
  }
  return chain
}

function sortTree(n: TreeNode): TreeNode {
  n.children.forEach(sortTree)
  n.children.sort((a, b) => b.total - a.total)
  n.txns.sort((a, b) => b.effective_date.localeCompare(a.effective_date) || b.amount - a.amount)
  return n
}

/** Build the category tree for one flow. `categories` supplies parent links (the
 *  embedded txn category has parent_id but its parent may not be embedded). */
export function buildCategoryTree(
  txns: Transaction[],
  flow: ReportFlow,
  categories: Category[],
  groups: CategoryGroup[] = [],
): TreeNode {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const groupsById = new Map(groups.map((g) => [g.id, g]))
  const hasChildren = new Set(categories.filter((c) => c.parent_id).map((c) => c.parent_id!))
  const root: TreeNode = { id: flow, label: flow === 'spend' ? 'Expenses' : 'Income', total: 0, children: [], txns: [] }

  const child = (parent: TreeNode, id: string, label: string, color?: string): TreeNode => {
    let n = parent.children.find((c) => c.id === id)
    if (!n) {
      n = { id, label, total: 0, children: [], txns: [], color }
      parent.children.push(n)
    }
    return n
  }

  for (const t of txns) {
    if (reportFlow(t) !== flow) continue
    const amt = flow === 'spend' ? t.amount : -t.amount
    const cat = t.category_id ? (byId.get(t.category_id) ?? t.categories ?? undefined) : undefined
    const path: TreeNode[] = [root]
    if (!cat) {
      path.push(child(root, UNCATEGORIZED, 'Uncategorized'))
    } else {
      const chain = ancestry(cat, byId)
      const top = chain[0]
      const group = top.group_id ? groupsById.get(top.group_id) : undefined
      let node = root
      if (group && group.name !== top.name) {
        node = child(root, `group:${group.id}`, group.name, group.color)
        path.push(node)
      }
      for (const c of chain) {
        node = child(node, c.id, c.name, c.color)
        path.push(node)
      }
      if (hasChildren.has(cat.id)) {
        node = child(node, `${cat.id}:other`, `${cat.name} (Other)`, cat.color)
        path.push(node)
      }
    }
    for (const n of path) n.total += amt
    path[path.length - 1].txns.push(t)
  }
  return sortTree(root)
}

/** Flatten a tree to display rows honoring a collapsed-id set. */
export type TreeRow =
  | { kind: 'header'; node: TreeNode; depth: number; collapsed: boolean }
  | { kind: 'txn'; txn: Transaction; node: TreeNode; depth: number }
  | { kind: 'total'; node: TreeNode; depth: number }

export function flattenTree(root: TreeNode, collapsed: Set<string>, depth = 0): TreeRow[] {
  const rows: TreeRow[] = []
  const isCollapsed = collapsed.has(root.id)
  rows.push({ kind: 'header', node: root, depth, collapsed: isCollapsed })
  if (isCollapsed) return rows
  for (const c of root.children) rows.push(...flattenTree(c, collapsed, depth + 1))
  for (const t of root.txns) rows.push({ kind: 'txn', txn: t, node: root, depth: depth + 1 })
  if (depth > 0) rows.push({ kind: 'total', node: root, depth })
  return rows
}

/** Category names that Simplifi's tax lines map as tax payments or deductions
 *  (Schedule A / credits). PocketLens has no TXF mapping, so this is by name. */
export const TAX_RELATED = /\b(tax|taxes|irs|charit|donation|medical|health|doctor|pharmacy|dental|education|tuition|student loan|childcare|child care|daycare|mortgage interest|property tax)/i

function byPayee(node: TreeNode, flow: ReportFlow): void {
  for (const c of node.children) byPayee(c, flow)
  if (node.txns.length === 0) return
  const payees = new Map<string, TreeNode>()
  for (const t of node.txns) {
    const name = t.merchant_name ?? t.description ?? 'Unknown'
    let p = payees.get(name)
    if (!p) {
      p = { id: `${node.id}:payee:${name}`, label: name, total: 0, children: [], txns: [] }
      payees.set(name, p)
    }
    p.txns.push(t)
    p.total += flow === 'spend' ? t.amount : -t.amount
  }
  node.children.push(...payees.values())
  node.txns = []
}

/** Simplifi's Taxes report, simplified: Income ▸ category ▸ payee, and
 *  Tax payments & deductions ▸ category ▸ payee. */
export function buildTaxTree(txns: Transaction[], categories: Category[], groups: CategoryGroup[] = []): TreeNode {
  const income = buildCategoryTree(txns, 'income', categories, [])
  income.label = 'Taxable income'
  const taxTxns = txns.filter((t) => {
    const name = t.categories?.name ?? (t.category_id ? categories.find((c) => c.id === t.category_id)?.name : undefined)
    return !!name && TAX_RELATED.test(name)
  })
  const deductions = buildCategoryTree(taxTxns, 'spend', categories, groups)
  deductions.label = 'Tax payments & deductions'
  deductions.id = 'deductions'
  byPayee(income, 'income')
  byPayee(deductions, 'spend')
  const root: TreeNode = { id: 'taxes', label: 'Taxes', total: 0, children: [income, deductions].filter((n) => n.total !== 0 || n.children.length > 0), txns: [] }
  return sortTree(root)
}

/** One-level tree (root ▸ group ▸ transactions) for non-category groupings. */
export function buildGroupTree(
  txns: Transaction[],
  flow: ReportFlow,
  keyOf: (t: Transaction) => { id: string; label: string; color?: string },
): TreeNode {
  const root: TreeNode = { id: flow, label: flow === 'spend' ? 'Expenses' : 'Income', total: 0, children: [], txns: [] }
  const byId = new Map<string, TreeNode>()
  for (const t of txns) {
    if (reportFlow(t) !== flow) continue
    const amt = flow === 'spend' ? t.amount : -t.amount
    const k = keyOf(t)
    let n = byId.get(k.id)
    if (!n) {
      n = { id: k.id, label: k.label, total: 0, children: [], txns: [], color: k.color }
      byId.set(k.id, n)
      root.children.push(n)
    }
    n.total += amt
    n.txns.push(t)
    root.total += amt
  }
  return sortTree(root)
}

/** Depth-first lookup of a node by id. */
export function findNode(root: TreeNode, id: string): TreeNode | null {
  if (root.id === id) return root
  for (const c of root.children) {
    const hit = findNode(c, id)
    if (hit) return hit
  }
  return null
}
