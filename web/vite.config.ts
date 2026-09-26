import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // VITE_BACKEND_URL lives in .env for local dev and is injected at build time
  // for self-hosted deploys. Bake its origin into the SW's runtime cache
  // matcher so NetworkFirst only ever applies to *our* backend's JSON API.
  const env = loadEnv(mode, __dirname)
  const backendOrigin = env.VITE_BACKEND_URL
    ? new URL(env.VITE_BACKEND_URL).origin
    : null
  // Only the JSON API endpoints — never the backend-hosted Plaid Link page
  // (/link/*, /onboard/*), which carries an access token in the URL fragment.
  // POSTs aren't intercepted by workbox GET routes anyway.
  const backendApiPattern = backendOrigin
    ? new RegExp(
        `^${escapeRegExp(backendOrigin)}/(sync/trigger|backfill|backfill-all|health)(?:/|$)`,
      )
    : /(?!)/ // VITE_BACKEND_URL unset: match nothing

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: 'auto',
        devOptions: { enabled: false },
        manifest: {
          name: 'PocketLens Budget',
          short_name: 'PocketLens',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          theme_color: '#008DD5',
          background_color: '#F7F7F7',
          description:
            'PocketLens — a barebones self-hosted budgeting app: spending plans, transactions, and card-churning tracking.',
          icons: [
            {
              src: '/icons/icon-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/icons/icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/icons/icon-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'maskable',
            },
            {
              src: '/icons/icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
          // SPA: offline navigations fall back to the app shell.
          navigateFallback: 'index.html',
          runtimeCaching: [
            {
              // Supabase PostgREST — any origin (supabase.co or self-hosted).
              // NetworkFirst: never serve stale financial data.
              urlPattern: /\/rest\/v1(?:\/|$)/,
              handler: 'NetworkFirst',
              options: {
                cacheName: 'supabase-rest',
                expiration: { maxEntries: 50, maxAgeSeconds: 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              // Supabase Auth — any origin.
              urlPattern: /\/auth\/v1(?:\/|$)/,
              handler: 'NetworkFirst',
              options: {
                cacheName: 'supabase-auth',
                expiration: { maxEntries: 20, maxAgeSeconds: 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            {
              // FastAPI backend JSON API only. /link/* and /onboard/* (the
              // backend-hosted Plaid Link pages) are deliberately excluded, as
              // are Plaid's own domains. No catch-all cache anywhere.
              urlPattern: backendApiPattern,
              handler: 'NetworkFirst',
              options: {
                cacheName: 'backend-api',
                expiration: { maxEntries: 20, maxAgeSeconds: 24 * 60 * 60 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  }
})
