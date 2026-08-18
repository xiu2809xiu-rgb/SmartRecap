import { Suspense, lazy, useEffect, useState } from 'react';
import { resolveState } from './states.js';
import { usePrefs } from '../lib/prefs.jsx';
import './mascot.css';

// Everything three.js touches sits behind this boundary, so importing Mascot
// costs nothing until a screen actually shows one.
const MascotCanvas = lazy(() => import('./MascotCanvas.jsx'));

const MODEL_URL = '/models/rec.glb';

/**
 * Resolves once per page load: is there a real model to load?
 *
 * A HEAD request rather than a build-time flag, so dropping `rec.glb` into
 * `public/models/` upgrades the app with no code change and no rebuild config.
 * A dev server that answers every path with `index.html` is caught by the
 * content-type check.
 */
let modelProbe = null;
function useModelUrl() {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    modelProbe ??= fetch(MODEL_URL, { method: 'HEAD' })
      .then((r) => (r.ok && !r.headers.get('content-type')?.includes('text/html') ? MODEL_URL : null))
      .catch(() => null);
    let alive = true;
    modelProbe.then((v) => alive && setUrl(v));
    return () => {
      alive = false;
    };
  }, []);
  return url;
}

/**
 * Rec.
 *
 * Three guarantees, because a mascot that hurts the product is worse than none:
 *  1. Reduced motion, or the mascot preference off, renders a flat badge — no
 *     WebGL context is created at all.
 *  2. The renderer is lazy, so it never blocks first paint; the badge stands in
 *     until the chunk lands.
 *  3. No model file still gives you an animated Rec, drawn in code.
 */
export default function Mascot({
  state = 'idle',
  size = 240,
  caption = false,
  className = '',
  intensity = 1,
  shadow = true,
}) {
  const { allowMascot } = usePrefs();
  const url = useModelUrl();
  const meta = resolveState(state);

  if (!allowMascot) {
    return <MascotBadge size={size} state={state} caption={caption} className={className} />;
  }

  return (
    <div
      className={`mascot ${className}`}
      style={{ width: size, height: size }}
      data-state={state}
      role="img"
      aria-label={`SmartRecap assistant: ${meta.caption}`}
    >
      <Suspense fallback={<MascotBadge size={size} state={state} />}>
        <MascotCanvas url={url} state={state} intensity={intensity} shadow={shadow} />
      </Suspense>
      {caption && <p className="mascot-caption">{meta.caption}</p>}
    </div>
  );
}

/**
 * The reduced-motion stand-in, and the loading state. Still Rec — same visor,
 * same ring — just not moving and not on the GPU.
 */
export function MascotBadge({ size = 240, state = 'idle', caption = false, className = '' }) {
  const meta = resolveState(state);
  return (
    <div className={`mascot mascot-badge ${className}`} style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 120 120"
        width={size}
        height={size}
        role="img"
        aria-label={`SmartRecap assistant: ${meta.caption}`}
      >
        <defs>
          <linearGradient id="rec-shell" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#7b52e8" />
            <stop offset="100%" stopColor="#3a1f8f" />
          </linearGradient>
          <radialGradient id="rec-glow">
            <stop offset="0%" stopColor="#00f0ff" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#00f0ff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="60" cy="62" r="44" fill="url(#rec-glow)" />
        <ellipse cx="60" cy="44" rx="34" ry="9" fill="none" stroke="#ff006e" strokeWidth="2" opacity="0.85" />
        <rect x="27" y="34" width="66" height="62" rx="31" fill="url(#rec-shell)" />
        <path d="M31 56a29 29 0 0 1 58 0Z" fill="#0a0616" opacity="0.92" />
        <circle cx="50" cy="50" r="4" fill="#00f0ff" />
        <circle cx="70" cy="50" r="4" fill="#00f0ff" />
        <circle cx="19" cy="72" r="7" fill="#6b45d6" />
        <circle cx="101" cy="72" r="7" fill="#6b45d6" />
      </svg>
      {caption && <p className="mascot-caption">{meta.caption}</p>}
    </div>
  );
}
