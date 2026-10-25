import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: './',
  build: { rollupOptions: { input: { desktop: fileURLToPath(new URL('./index.html', import.meta.url)), mobile: fileURLToPath(new URL('./mobile.html', import.meta.url)) } } },
  plugins: [react(), {
    name: 'dev-csp',
    apply: 'serve',
    transformIndexHtml: html => html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';"),
  }],
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
});
