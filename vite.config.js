import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const DEV_API_TARGET = process.env.DEV_API_TARGET || 'http://127.0.0.1:8000';

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
      // Defaults to a backend on this machine. Point it at a deployed API with
      //   DEV_API_TARGET=https://your-host npm run dev
      // Going through the proxy keeps the browser same-origin, so the deployed
      // CORS_ORIGINS does not have to list localhost to make dev work.
      '/api': { target: DEV_API_TARGET, changeOrigin: true },
      '/ws': { target: DEV_API_TARGET.replace(/^http/, 'ws'), ws: true, changeOrigin: true },

      /**
       * Tunnel for the presigned upload PUT.
       *
       * `POST /api/uploads` hands back an absolute S3 URL, so the browser talks
       * to S3 directly and the proxy above never sees it. The bucket's CORS
       * lists only the deployed web origin, so that PUT fails from localhost
       * with "Failed to fetch" even when the API itself is reachable.
       *
       * api.js rewrites those URLs to /__dev-s3/<host>/<key> in dev only. The
       * signature survives because the path and query are untouched and
       * changeOrigin restores the Host header S3 signed for.
       */
      '/__dev-s3': {
        target: 'https://s3.amazonaws.com',
        changeOrigin: true,
        router: (req) => `https://${req.url.split('/')[2]}`,
        rewrite: (path) => path.replace(/^\/__dev-s3\/[^/]+/, ''),
      },
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
