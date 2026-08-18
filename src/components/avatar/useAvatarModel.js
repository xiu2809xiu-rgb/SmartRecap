import { useEffect, useState } from 'react';
import { usePrefs } from '../../lib/prefs.jsx';

export const AVATAR_URL = `${import.meta.env.BASE_URL}models/avatar.glb`;

/**
 * Whether the avatar can and should be shown here.
 *
 * Two gates, because the file is ~17 MB:
 *
 *   1. `allowMascot` — false under reduced motion or when 3D is off in
 *      Settings. Nothing is fetched in that case at all.
 *   2. Present — a HEAD request that also rejects a `text/html` reply, because
 *      the dev server answers unknown paths with index.html and a
 *      200-that-is-really-HTML would crash the GLTF parser rather than 404.
 *
 * The probe result is shared across callers through a module-level promise, so
 * mounting this on both the auth page and the landing page costs one request,
 * and the browser cache makes the second component's model load instant.
 */
let probe = null;

function modelExists() {
  probe ??= fetch(AVATAR_URL, { method: 'HEAD' })
    .then((res) => res.ok && !(res.headers.get('content-type') ?? '').includes('text/html'))
    .catch(() => false);
  return probe;
}

export default function useAvatarModel({ enabled = true } = {}) {
  const { allowMascot } = usePrefs();
  const [exists, setExists] = useState(null);

  useEffect(() => {
    if (!enabled || !allowMascot) return undefined;
    let cancelled = false;
    modelExists().then((ok) => {
      if (!cancelled) setExists(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, allowMascot]);

  return {
    url: AVATAR_URL,
    allowed: allowMascot,
    /** Null while the probe is in flight — callers show their fallback until then. */
    exists,
    ready: allowMascot && exists === true,
  };
}
