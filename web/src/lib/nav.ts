// The single nav config for the whole app: the Simplifi-style sidebar.
// Dashboard and Spending Plan intentionally land on the same home page (the
// spending plan IS this app's dashboard); each entry keeps its own highlight.

import {
  BarChart3,
  CreditCard,
  Gift,
  Landmark,
  LayoutDashboard,
  PiggyBank,
  ReceiptText,
  Settings,
  TrendingUp,
  Trophy,
  Wallet,
  type LucideIcon,
} from "lucide-react";

type NavItem = { label: string; to: string; icon: LucideIcon };

export const sidebarNav: NavItem[] = [
  { label: "Dashboard", to: "/", icon: LayoutDashboard },
  { label: "Transactions", to: "/transactions", icon: ReceiptText },
  { label: "Accounts", to: "/accounts", icon: Landmark },
  { label: "Spending Plan", to: "/spending-plan", icon: PiggyBank },
  { label: "Budgets", to: "/budgets", icon: Wallet },
  { label: "Churning", to: "/churning", icon: CreditCard },
  { label: "Rewards", to: "/rewards", icon: Gift },
  { label: "Discretionary", to: "/discretionary", icon: Trophy },
  { label: "Reports", to: "/reports", icon: BarChart3 },
  { label: "Retirement", to: "/retirement", icon: TrendingUp },
  { label: "Settings", to: "/settings", icon: Settings },
];

/** Active-route matching: exact for "/" and "/spending-plan", prefix for
 *  section roots so /accounts/:id highlights Accounts. Pathname only. */
export function isNavActive(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}
