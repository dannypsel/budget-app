// Notification bell for the TopAppBar — unread-count badge + dropdown inbox.
// Lists notifications newest-first with title/body/relative time, per-item
// "Mark read" and a "Mark all read" action. Existing design tokens only.

import { Bell } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotificationCount,
} from '@/data/hooks'
import { formatRelativeTime } from '@/lib/dates'
import { cn } from '@/lib/utils'

export default function NotificationBell() {
  const { data: notifications = [], isError } = useNotifications()
  const unread = useUnreadNotificationCount()
  const markRead = useMarkNotificationRead()
  const markAll = useMarkAllNotificationsRead()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-container-high hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      >
        <Bell className="h-5 w-5" aria-hidden />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <p className="text-sm font-semibold text-foreground">Notifications</p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={unread === 0 || markAll.isPending}
            onClick={() => void markAll.mutateAsync()}
          >
            {markAll.isPending ? 'Marking…' : 'Mark all read'}
          </Button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto">
          {isError ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              Notifications aren't available right now.
            </p>
          ) : notifications.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              You're all caught up — no notifications.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {notifications.map((n) => (
                <li
                  key={n.id}
                  className={cn('px-4 py-3', !n.is_read && 'bg-secondary-container/25')}
                >
                  <div className="flex items-start gap-2">
                    {!n.is_read && (
                      <span
                        aria-hidden
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium leading-5 text-foreground">{n.title}</p>
                      <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{n.body}</p>
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">
                          {formatRelativeTime(n.created_at)}
                        </span>
                        {!n.is_read && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            disabled={markRead.isPending}
                            onClick={() => void markRead.mutateAsync(n.id)}
                          >
                            Mark read
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
