# Simplifi reverse-engineering findings (REA, 2026-10-20)

Sources: REA 6.7.0 (`rea list-browser-targets`, `inspect-web-page --include-script-sources`,
`analyze-web-bundle`) against `https://simplifi.quicken.com/` in a debug Chrome, plus direct reads
of the shipped first-party bundles `main.7ec2b778e6504377fc10.js`,
`pnpm.app-components.85bd1c062c8750b253d5.js`, `4659.039b07c5957418b7f727.js`.
Source maps are not public (the `.map` URLs return the SPA HTML). `analyze-web-bundle` on the live
page OOMs at 12 GB (52 scripts); it succeeds against a loopback mirror of the three first-party
bundles. Simplifi amounts are signed opposite to PocketLens (Simplifi: < 0 = outflow).

## Classification (chartOfAccounts, module 208810 / 256865)

- Every transaction / split item carries `coa = {type, id}`; `type` is `CATEGORY`, `ACCOUNT`
  (transfer to that account), `BALANCE_ADJUSTMENT` (`0` Balance Adjustment, `1` Opening Balance,
  `2` Transfer, `3` Credit Card Payment) or `UNCATEGORIZED`.
- `isTransferCOA(coa) = type in {ACCOUNT, BALANCE_ADJUSTMENT}`.
- Categories have `type: INCOME | EXPENSE`. `isIncome(coa)` = CATEGORY whose id is in the income
  set. Income vs spending is decided by category type, never by sign.
  `isCoaEligibleForCategoryType`: UNCATEGORIZED is eligible only for EXPENSE.
- `isBill` = Credit Card Payment, or expense category, or either side is a CREDIT/LOAN account.
- Choosing a transfer coa in the edit form sets `isExcludedFromReports = true`; moving off a
  transfer clears it (unless the account itself is excluded). Income/transfer clears
  `isBill`/`isSubscription`.
- New transactions inherit `account.isExcludedFromReports` / `account.isExcludedFromBudgets`.
- Category records carry `isExcludedFromReports`, `isExcludedFromBudgets`.
- Report grouping: `getCategoryGroup` = root (L1) category; transfers group as
  "Transfer Expense" / "Transfer Income" by direction; amounts on a parent itself become
  `"<Parent> (Other)"`; uncategorized -> "Uncategorized".
- Payee/Tag drill: income vs spending by category membership in the income set, not by sign.

## Transaction model fields

`isReviewed`, `tags[]`, `memo`, `split.items[] {coa, amount, memo, tags}`, `attachments[]`,
`userFlag` (RED, ORANGE, YELLOW, GREEN, BLUE, VIOLET, BLACK, BROWN, NONE), `userFlagNote`,
`state` (PENDING | CLEARED), `source`, `cpData.payee` (original statement payee),
`isExcludedFromReports`, `isExcludedFromF2S`, `isBill`, `isSubscription`, `checkNumber`.
Register groups pending under sentinel key `"9999-99:Pending"` (sorts above every month).
Transaction filters include `flags` (with NONE = unflagged), categories, tags, accounts.

## Routes / reports

`/transactions`, `/spending`, `/net-worth`, `/reports/:tabName?/:groupBy?/:layoutView?`,
`/reports/monthly-summary`, `/saved-reports/:tabName?`, `/scheduled-transactions`, `/upcoming`.
Report subtypes in client code: SPENDING, INCOME, SAVINGS, NET_WORTH. Group-by dimensions:
Category, Payee, Tag (plus account/business/usage). Report rows are server-computed trees with
`parentId`, `isTotal`, `isExcludedFromReports`; "(credit)" / "(loss)" suffixes mark
sign-inverted rows inside a spending/income group.

## Hands-on (signed-in Simplifi, read-only; nothing saved)

- Accounts panel pinned (collapsible) on Dashboard and Transactions; not on Reports.
- Transactions: All / Spending / Income tabs. Register groups Pending first, then by month;
  columns Date, Account, Reviewed, Payee, Category, Amount; quick filters This month /
  Uncategorized / Unreviewed.
- Spending tab: By category ▾, Recent 12 months ▾, Filters; "Total expenses"; donut with top 9
  + "Everything else"; pie/bar toggle; Total ▾ (total vs average); Transaction Activity register
  with search + "Shortcuts" syntax drawer and an Exclusion column.
- Search DSL (common chunk module 330420, `parseDSL`): tokens split on spaces outside quotes;
  `is:`/`not:` keywords (reviewed, excluded, flag, notes, tags, pending, cleared,
  uncategorized); `field op value` with ops `: = != > >= < <= ~=`; ranges `a..b`; `50ish`
  (±10%); comma OR lists; `expense`/`income` imply sign; relative dates (today … ytd, q1-q4,
  ±Nd/w/m/y, yyyy-mm, yyyy-qN); "this month" etc. normalized.
- Reports home: Spending, Spending Summary, Income, Income Summary, Income & Expense, Net Worth,
  Taxes, Savings + Monthly Summary snapshot; saved reports sidebar.
- Spending report table "Expense transactions by category": Expenses ▸ L1 ▸ L2 ▸ txns with
  "Total X" rows (columns Category, Date, Account, Payee, Tags, Amount).
- Net Worth / Savings: area chart + "<…> by month" table, Assets ▸ type ▸ account with totals.
- Taxes: "Tax detail" tree Income ▸ Form 1040 ▸ line ▸ payee ▸ txns (TXF mappings).

## ProjectionLab (REA analyze-web-bundle on live app.projectionlab.com)

Routes include `/plan/:plan`, `/progress`, `/today`, `/settings` (plan sub-views cash-flow,
monte-carlo, strategy, tax-analytics from the 2026-10-20 pass). In-scope Retirement items
(named scenarios, click-a-year, best/expected/worst, after-tax, 5 buckets) already exist; this
pass only persists the unsaved working model across reloads.

## PocketLens gap list (vs. code at d280a55)

Missing:
1. Accounts panel on every page (only on Dashboard).
2. Pinned Pending section in the register (only an inline label).
3. Spending / Income analysis tabs on Transactions with group-by category/payee/tag, totals,
   pie/bar toggle.
4. Structured search syntax (payee:, category=, amount>/</=, date=/>/<, is:reviewed,
   is:pending, tags:, account:, flag:).
5. Report tree table (parent -> subcategory totals, "(Other)" bucket); reports group by leaf only.
6. Savings and Net Worth report types (`account_balance_history` + `net_worth_snapshots` already
   exist; no UI reads them). Taxes report.
7. Classification by category type: `categories.kind` exists but the client never uses it;
   income is decided by sign.
8. Category-level exclude-from-reports.
9. Transaction extras: color flags + flag note, attachments, statement name
   (Plaid `original_description` not stored), memo editing, tag assignment UI, split editor,
   create-rule-from-transaction, recurring actions from a transaction.
10. Dashboard accounts: last-synced time; separate Loans group.

Already present (keep): reviewed flag + bulk review, transfer linking + auto-detect, splits
display, exclude_from_totals / hidden / reimbursement, saved reports, compare-to-prior,
forecast, monthly summary, Retirement scenarios / year detail / bands / after-tax / five buckets.

## Implemented in this pass

1 accounts panel on Transactions (collapsible, xl screens) + Loans group, persisted Privacy Mode,
last-synced time; 2 pinned Pending group; 3 Spending/Income tabs; 4 search DSL + Shortcuts
drawer; 5 report tree with "(Other)"; 6 Net Worth, Savings, Taxes (name-based tax categories,
no TXF) reports; 7 category-type classification (lib/classify) across reports and tabs, splits
attributed per split; 8 category-level exclude + editable category type; 9 flags + note,
statement name (Plaid original_description), notes, tags, split editor, attachments (private
bucket), create-rule, recurring confirm/ignore from the transaction dialog; 10 see 1.
Not done: Simplifi's server-side TXF tax-line mapping; account-level exclude-from-reports.
