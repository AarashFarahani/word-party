import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// base './' makes every built asset URL relative, so the app works unchanged at / and under any
// reverse-proxy prefix (for example Caddy serving it at /word-party/). No base-path setting needed.
export default defineConfig({ base: './', plugins: [react()], server: { host: '0.0.0.0', port: 5173 } });
