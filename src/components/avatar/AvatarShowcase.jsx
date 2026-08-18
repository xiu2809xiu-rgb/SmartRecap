import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Icon, Spinner } from '../ui.jsx';
import { usePrefs } from '../../lib/prefs.jsx';
import ParticleText from '../ParticleText.jsx';
import './avatar.css';

const AvatarStage = lazy(() => import('./AvatarStage.jsx'));

const MODEL_URL = `${import.meta.env.BASE_URL}models/avatar.glb`;

/**
 * The person who built this, as a 3D model.
 *
 * Three gates before a single byte of it downloads, because the file is ~17 MB
 * and this sits on the marketing page:
 *
 *   1. `allowMascot` — off under reduced motion, or if the student turned 3D
 *      off in Settings. A spinning figure is exactly what that setting is for.
 *   2. In view — an IntersectionObserver, so arriving at the homepage and
 *      reading the hero costs nothing. Most visitors never scroll this far.
 *   3. Present — a HEAD request first, the same trick `mascot/Mascot.jsx` uses,
 *      because the dev server answers unknown paths with index.html and a
 *      200-that-is-really-HTML would otherwise crash the GLTF parser.
 *
 * Once it has been in view it stays mounted: unloading and refetching 17 MB on
 * every scroll past would be worse than keeping it.
 */
export default function AvatarShowcase() {
  const sectionRef = useRef(null);
  const { allowMascot } = usePrefs();

  const [seen, setSeen] = useState(false);
  const [exists, setExists] = useState(null);

  useEffect(() => {
    const node = sectionRef.current;
    if (!node || !allowMascot) return undefined;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setSeen(true);
      },
      // Starts a little before it reaches the viewport so the download has a
      // head start, but not so early that scrolling past the hero triggers it.
      { rootMargin: '200px 0px', threshold: 0.01 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [allowMascot]);

  useEffect(() => {
    if (!seen || exists !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(MODEL_URL, { method: 'HEAD' });
        const type = res.headers.get('content-type') ?? '';
        if (!cancelled) setExists(res.ok && !type.includes('text/html'));
      } catch {
        if (!cancelled) setExists(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [seen, exists]);

  return (
    <section id="built-by" className="section avatar-section" ref={sectionRef}>
      <div className="shell avatar-grid">
        <div className="avatar-copy">
          <p className="eyebrow">Built by</p>

          <h2 className="section-title">A team who had the same problem</h2>
          <p className="lede">
            SmartRecap was built for the Nanyang Polytechnic Cloud Computing Club hackathon by a team of students who
            had all spent too many nights re-reading slides to check whether a summary was telling the truth. The
            frontend, the grounding pipeline, the backend and the deployment were each somebody&rsquo;s week.
          </p>
          <p className="avatar-note">
            <Icon name="drag_pan" size={16} />
            {allowMascot
              ? 'Drag to turn the model.'
              : '3D is off in your settings, so this is shown as a still. Turn it back on under Settings → Motion.'}
          </p>
        </div>

        <div className="avatar-frame">
          {allowMascot && seen && exists === true && (
            <Suspense fallback={<div className="avatar-loading" role="status"><Spinner size={22} /><span>Loading…</span></div>}>
              <AvatarStage url={MODEL_URL} />
            </Suspense>
          )}

          {/* The name labels the MODEL rather than heading the section. It is
              whose likeness this is — a caption, not a byline. Heading the
              section with one person's name read as sole credit for work four
              people did. */}
          {allowMascot && seen && exists === true && (
            <figcaption className="avatar-caption">
              <ParticleText text="Richie Koh" className="avatar-name" ratio={0.19} />
              <span className="sr-only">Richie Koh</span>
              <span className="avatar-caption-role">modelled himself for this page</span>
            </figcaption>
          )}

          {/* Everything that is not the live model: 3D disabled, the file
              missing, or not yet scrolled to. All three land on the same quiet
              placeholder rather than an error or a hole in the layout. */}
          {(!allowMascot || exists === false || (seen && exists === null)) && (
            <div className="avatar-placeholder">
              <Icon name={exists === false ? 'view_in_ar_off' : 'view_in_ar'} size={40} />
              <p>
                {!allowMascot
                  ? '3D is turned off'
                  : exists === false
                    ? 'Model not found in public/models/'
                    : 'Checking for the model…'}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
