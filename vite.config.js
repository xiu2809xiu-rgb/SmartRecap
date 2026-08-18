import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Pinned, and strict on purpose.
    //
    // Vite's default is to walk to the next free port when 5173 is taken. That
    // is friendly until you use Google sign-in: the OAuth client authorises
    // specific JavaScript origins, so a silent move to :5174 produces
    // "Error 400: origin_mismatch" inside Google's own popup, where the app
    // cannot see it or explain it. Failing loudly with "Port 5173 is already
    // in use" is a far better trade — that message tells you exactly what to
    // do, and it takes ten seconds.
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
    watch: {
      ignored: ['**/backend/.venv/**', '**/.paddlex/**', '**/__pycache__/**'],
    },
  },
  build: {
    // The heavy libraries are split by hand so a route that does not use them
    // never downloads them. three/drei in particular is ~600 kB and is only
    // reached through the lazily-loaded mascot canvas.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](three|@react-three)[\\/]/.test(id)) return 'three';
          if (/[\\/]node_modules[\\/](gsap|@gsap)[\\/]/.test(id)) return 'gsap';
          if (/[\\/]node_modules[\\/](motion|framer-motion|motion-dom|motion-utils)[\\/]/.test(id)) return 'motion';
          if (/[\\/]node_modules[\\/]ogl[\\/]/.test(id)) return 'ogl';
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return 'react';
          }
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
});
