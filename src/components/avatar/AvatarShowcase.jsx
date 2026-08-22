import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Icon, Spinner } from '../ui.jsx';
import { usePrefs } from '../../lib/prefs.jsx';
import ParticleText from '../ParticleText.jsx';
import { AVATARS } from './roster.js';
import './avatar.css';

const AvatarStage = lazy(() => import('./AvatarStage.jsx'));

/**
 * Is this model actually there, keyed by URL.
 *
 * A HEAD request that also rejects a `text/html` reply, because the dev server
 * answers unknown paths with index.html and a 200-that-is-really-HTML would
 * crash the GLTF parser rather than 404. Cached per URL at module scope so
 * flicking back and forth through the carousel re-probes nothing.
 */
const probes = new Map();

function modelExists(url) {
  if (!probes.has(url)) {
    probes.set(
      url,
      fetch(url, { method: 'HEAD' })
        .then((res) => res.ok && !(res.headers.get('content-type') ?? '').includes('text/html'))
        .catch(() => false),
    );
  }
  return probes.get(url);
}

/**
 * The people who built this, as 3D models, one at a time.
 *
 * The gating is the reason this is not just two <AvatarStage>s side by side.
 * These files are 9-17 MB each, and this sits on the marketing page, so nothing
 * downloads until all three of these are true:
 *
 *   1. `allowMascot` — off under reduced motion, or if the student turned 3D
 *      off in Settings. A spinning figure is exactly what that setting is for.
 *   2. In view — an IntersectionObserver, so arriving at the homepage and
 *      reading the hero costs nothing. Most visitors never scroll this far.
 *   3. Present — the HEAD probe above.
 *
 * And then only for the person you are actually looking at. There is no
 * preloading of the next one and no autoplay: an autoplaying carousel here
 * would quietly pull every model in the roster down the wire on a page nobody
 * asked to be shown 3D on, and would yank the figure away mid-drag. You advance
 * it, or it stays put.
 *
 * There is exactly one <AvatarStage> for the whole carousel, not one per
 * person. See the note in that file — the short version is that WebGL contexts
 * are capped per page, and drei caches parsed models by URL, so swapping the
 * prop is both safer and faster than mounting four canvases.
 */
export default function AvatarShowcase() {
  const sectionRef = useRef(null);
  const { allowMascot } = usePrefs();

  const [seen, setSeen] = useState(false);
  const [index, setIndex] = useState(0);
  const [exists, setExists] = useState({});

  const active = AVATARS[index];
  const activeExists = exists[active.url];

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

  // Probe every model at once, not just the one on screen.
  //
  // These are HEAD requests — four of them, no bodies, answered in a few
  // milliseconds — so doing them together costs nothing next to a single model
  // download, and it is what keeps the stage mounted. Probing lazily meant that
  // clicking to the next person put `exists[url]` back to undefined for as long
  // as their probe was in flight, which unmounted <AvatarStage>, destroyed its
  // WebGL context and built a fresh one on the other side. That is precisely
  // the churn this component is arranged to avoid, and in practice the rebuilt
  // canvas did not always come back: the stage would sit at opacity 0 behind
  // its spinner with a perfectly good model loaded inside it.
  useEffect(() => {
    if (!seen || !allowMascot) return undefined;
    let cancelled = false;
    AVATARS.forEach(({ url }) => {
      modelExists(url).then((ok) => {
        if (!cancelled) setExists((prev) => (prev[url] === ok ? prev : { ...prev, [url]: ok }));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [seen, allowMascot]);

  // The last person confirmed to have a model. Belt and braces for the same
  // problem: if someone clicks through before the probes land, the stage keeps
  // showing whoever it was already showing rather than unmounting. Holding the
  // previous figure for a moment is a far better failure than tearing the
  // canvas down and hoping it comes back.
  const lastGood = useRef(null);
  if (activeExists === true) lastGood.current = active.url;

  // A model that is genuinely missing is the one case where coming down is
  // right — better an honest placeholder than the previous person standing
  // under someone else's name.
  const stageUrl = activeExists === false ? null : (activeExists === true ? active.url : lastGood.current);
  const staged = AVATARS.find((p) => p.url === stageUrl) ?? active;

  const go = useCallback((next) => setIndex((next + AVATARS.length) % AVATARS.length), []);

  // Left/right anywhere in the carousel, which is what someone who has just
  // tabbed to an arrow expects. The canvas itself swallows drags for
  // OrbitControls, so the keyboard is the only gesture free to mean "next".
  const onKeyDown = (e) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(index - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(index + 1);
    }
  };

  const many = AVATARS.length > 1;

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
              ? many
                ? 'Drag to turn the model. Arrows to meet the rest of us.'
                : 'Drag to turn the model.'
              : '3D is off in your settings, so this is shown as a still. Turn it back on under Settings → Motion.'}
          </p>
        </div>

        <div
          className="avatar-carousel"
          role="group"
          aria-roledescription="carousel"
          aria-label="The team, as 3D models"
          onKeyDown={onKeyDown}
        >
          <figure className="avatar-figure">
            <div className="avatar-frame">
              {allowMascot && seen && stageUrl && (
                <Suspense
                  fallback={
                    <div className="avatar-loading" role="status">
                      <Spinner size={22} />
                      <span>Loading…</span>
                    </div>
                  }
                >
                  <AvatarStage
                    url={stageUrl}
                    thoughts={staged.thoughts}
                    animated={staged.animated}
                    // A static mesh only reads as 3D if something turns it.
                    spin={!staged.animated}
                  />
                </Suspense>
              )}

              {/* Everything that is not the live model: 3D disabled, the file
                  missing, or not yet scrolled to. All three land on the same
                  quiet placeholder rather than an error or a hole in the
                  layout. */}
              {(!allowMascot || (seen && !stageUrl)) && (
                <div className="avatar-placeholder">
                  <Icon name={activeExists === false ? 'view_in_ar_off' : 'view_in_ar'} size={40} />
                  <p>
                    {!allowMascot
                      ? '3D is turned off'
                      : activeExists === false
                        ? `${active.name}’s model is missing from public/models/`
                        : 'Checking for the model…'}
                  </p>
                </div>
              )}

              {many && allowMascot && (
                <>
                  <button
                    type="button"
                    className="avatar-arrow is-prev"
                    onClick={() => go(index - 1)}
                    aria-label={`Show ${AVATARS[(index - 1 + AVATARS.length) % AVATARS.length].name}`}
                  >
                    <Icon name="chevron_left" size={22} />
                  </button>
                  <button
                    type="button"
                    className="avatar-arrow is-next"
                    onClick={() => go(index + 1)}
                    aria-label={`Show ${AVATARS[(index + 1) % AVATARS.length].name}`}
                  >
                    <Icon name="chevron_right" size={22} />
                  </button>
                </>
              )}
            </div>

            {/* The name captions the MODEL rather than heading the section. It
                is whose likeness this is — a caption, not a byline. Heading the
                section with one person's name read as sole credit for work four
                people did.

                Keyed on the person so changing slide rebuilds the particle
                field from scratch: the letters scatter and reassemble, which is
                what tells you the caption changed with the figure rather than
                just swapping text underneath it. */}
            {allowMascot && seen && activeExists === true && (
              <figcaption className="avatar-caption">
                <ParticleText key={active.id} text={active.name} className="avatar-name" ratio={0.19} />
              </figcaption>
            )}

            {/* Mounted unconditionally, outside the caption. The particle canvas
                is aria-hidden, so this is the name as far as a screen reader is
                concerned — and a live region only announces changes to a region
                that was already there. Mounting it together with the caption
                would have meant the first slide announced nothing and every
                later one announced late. */}
            <span className="sr-only" aria-live="polite">
              {allowMascot && seen && activeExists === true ? active.name : ''}
            </span>
          </figure>

          {many && allowMascot && (
            <div className="avatar-dots">
              {AVATARS.map((person, i) => (
                <button
                  key={person.id}
                  type="button"
                  aria-current={i === index}
                  aria-label={`Show ${person.name}`}
                  className={`avatar-dot ${i === index ? 'is-on' : ''}`}
                  onClick={() => go(i)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
