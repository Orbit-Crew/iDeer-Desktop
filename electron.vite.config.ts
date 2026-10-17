import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      target: 'node16',
      rollupOptions: {
        output: { banner: readFileSync('resources/compat/node16-banner.cjs', 'utf8') }
      }
    }
  },
  preload: { plugins: [externalizeDepsPlugin()], build: { target: 'node16' } },
  renderer: {
    base: './',
    server: { host: '127.0.0.1' },
    resolve: { alias: { '@renderer': resolve('src/renderer/src') } },
    plugins: [react(), {
      name: 'desktop-dev-csp',
      apply: 'serve',
      // Vite injects its refresh script and websocket in local development only.
      transformIndexHtml: (html) => html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]+>/, '')
    }],
    build: { target: 'chrome108' }
  }
})
