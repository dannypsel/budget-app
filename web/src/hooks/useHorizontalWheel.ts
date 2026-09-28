import { useEffect, type RefObject } from 'react'

/**
 * Redirect vertical mouse-wheel/trackpad scrolls into horizontal scrolling on a
 * horizontally-overflowing element. Browsers register wheel listeners as passive
 * by default, so this attaches a native listener with { passive: false } to
 * call preventDefault(). Pair with `overflow-x-auto` on the element: the
 * browser's native horizontal scrollbar stays visible, and wheel scrolling
 * moves the content horizontally. (Global table rule.)
 */
export function useHorizontalWheel(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const handler = (e: WheelEvent) => {
      if (e.deltaY === 0) return
      // Only hijack when there's somewhere horizontal to go — otherwise let the
      // page scroll normally.
      if (el.scrollWidth <= el.clientWidth) return
      e.preventDefault()
      el.scrollBy({ left: e.deltaY, behavior: 'auto' })
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [ref])
}
