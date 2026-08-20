import { defineConfig } from 'vite';
import https from 'node:https';
import react from '@vitejs/plugin-react';

/**
 * Tunnel for the presigned upload PUT, development only.
 *
 * `POST /api/uploads` hands back an absolute S3 URL, so the browser talks to
 * S3 directly and the /api proxy never sees it. The bucket's CORS lists only
 * the deployed web origin, so that PUT fails from localhost.
 *
 * api.js rewrites those URLs to /__dev-s3/<host>/<key>?<query>. This forwards
 * them on, and the presigned signature still validates because:
 *   - path and query are passed through byte for byte, and
 *   - the only headers forwarded are content-type and content-length. S3 signs
 *     `host` and `content-type`; node sets Host from the upstream host here,
 *     and the browser's Origin and Referer are dropped rather than confusing
 *     the signature check.
 *
 * This is a plugin and not a `server.proxy` entry because Vite's proxy is
 * node-http-proxy, which has no per-request `router` option — that belongs to
 * http-proxy-middleware. Configured there, every request went to one fixed
 * host and S3 answered 403 SignatureDoesNotMatch.
 */
function devS3Tunnel() {
  return {
    name: 'dev-s3-tunnel',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev-s3', (req, res, next) => {
        const match = (req.url || '').match(/^\/([^/]+)(\/.*)$/);
        if (!match) return next();
        const [, host, pathAndQuery] = match;

        const headers = {};
        for (const name of ['content-type', 'content-length']) {
          if (req.headers[name]) headers[name] = req.headers[name];
        }

        const upstream = https.request({ host, path: pathAndQuery, method: req.method, headers }, (upstreamRes) => {
          res.statusCode = upstreamRes.statusCode || 502;
          upstreamRes.pipe(res);
        });
        upstream.on('error', (error) => {
          res.statusCode = 502;
          res.end(`dev-s3 tunnel could not reach ${host}: ${error.message}`);
        });
        req.pipe(upstream);
      });
    },
  };
}

const DEV_API_TARGET = process.env.DEV_API_TARGET || 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react(), devS3Tunnel()],
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

      // The presigned upload PUT is tunnelled by the devS3Tunnel plugin below
      // rather than by this table, because it has to pick its upstream host
      // per request and `server.proxy` cannot do that.
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
