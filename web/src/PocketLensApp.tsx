import { useEffect, useRef } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { ThemeProvider, useTheme } from 'next-themes'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import AppLayout from '@/components/AppLayout'
import { Toaster as Sonner } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAutoSyncOnLogin, useMyProfile } from '@/data/hooks'
import { setDefaultCurrency } from '@/lib/money'
import { AuthProvider, useAuth } from '@/lib/auth'
import LoginPage from '@/pages/LoginPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import queryClient from './queryClient'
import NotFoundPage from './pages/NotFoundPage'
import { AppRouteTable } from './routes'

/** Sign-in fallback for the scheduled sync: see useAutoSyncOnLogin. Rendered only
 *  inside the signed-in tree. */
function AutoSyncOnLogin() {
  const { user } = useAuth()
  useAutoSyncOnLogin(user?.id ?? null)
  return null
}

/** Apply the user's saved profile prefs once auth is ready: the display
 *  currency becomes money.ts's global default, and the saved theme is applied
 *  via next-themes (the user can still change it in Settings → General). */
function ProfileBootstrap() {
  const { data: profile } = useMyProfile()
  const { setTheme } = useTheme()
  const themeApplied = useRef(false)
  useEffect(() => {
    if (!profile) return
    setDefaultCurrency(profile.currency ?? 'USD')
    // Apply the saved theme once; later changes in Settings call setTheme
    // directly and persist back to profile.theme, so don't fight them.
    if (!themeApplied.current && profile.theme) {
      themeApplied.current = true
      setTheme(profile.theme)
    }
  }, [profile, setTheme])
  return null
}

/** Logged-out experience: a plain login wall. /signup opens the sign-up tab. */
function LoggedOutRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/signup" element={<LoginPage initialMode="signup" />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    </BrowserRouter>
  )
}

function AppRoutes() {
  const { session, loading, recovery } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    )
  }

  // A recovery link signs the user in AND flags recovery — force the reset screen before
  // the app so a leaked/forgotten password can't be used as a silent back-door login.
  if (recovery) return <ResetPasswordPage />

  // Logged out → the login wall.
  if (!session) return <LoggedOutRoutes />

  return (
    <BrowserRouter>
      <AutoSyncOnLogin />
      <ProfileBootstrap />
      <Routes>
        <Route element={<AppLayout />}>{AppRouteTable}</Route>
        {/* A signed-in user landing on /login or /signup goes home instead (a fresh
            signup is then routed on to the setup wizard by AppLayout). */}
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/signup" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default function PocketLensApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <TooltipProvider>
          <Sonner />
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
