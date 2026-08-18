import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { usePrefs } from '../lib/prefs.jsx';
import { CitationProvider, Claim, SourceCard, CitationRibbon } from '../components/Citations.jsx';
import { Brand } from '../components/layout/Shells.jsx';
import { Icon, Spinner, Empty } from '../components/ui.jsx';
import './recap.css';
import './shared.css';

/**
 * Public, read-only view of a shared recap.
 *
 * Deliberately unauthenticated and deliberately partial: the recap and its
 * sources are visible, the owner's quiz history is not. It also runs on the
 * light study surface, because the person opening this link came to read.
 */
export default function SharedRecap() {
  const { token } = useParams();
  const { reduced } = usePrefs();
  const [material, setMaterial] = useState(null);
  const [error, setError] = useState(null);
  const readerRef = useRef(null);

  useEffect(() => {
    document.documentElement.dataset.surface = 'study';
    return () => {
      delete document.documentElement.dataset.surface;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.share
      .get(token)
      .then((m) => !cancelled && setMaterial(m))
      .catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (error) {
    return (
      <div className="shared">
        <SharedBar />
        <div className="shell">
          <Empty
            icon="link_off"
            title="This link is no longer valid"
            body="The recap may have been deleted, or the share link revoked by its owner."
            action={
              <Link to="/" className="btn btn-primary">
                See what SmartRecap does
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  if (!material) {
    return (
      <div className="shared">
        <SharedBar />
        <div className="shell shared-loading" role="status">
          <Spinner size={22} />
          <span>Loading the shared recap…</span>
        </div>
      </div>
    );
  }

  const { recap, chunks = [] } = material;

  return (
    <div className="shared">
      <SharedBar />

      <main className="shell shared-main" id="main">
        <header className="shared-head">
          <p className="eyebrow">Shared recap</p>
          <h1>{material.title}</h1>
          <p className="shared-meta">
            {material.module} · {material.pageCount} pages · {recap.readMinutes} minute read
          </p>
        </header>

        <CitationProvider chunks={chunks}>
          <div className="reader-grid" ref={readerRef}>
            <div className="reader-col">
              <section className="tldr">
                <h2 className="tldr-title">
                  <Icon name="bolt" size={19} />
                  The short version
                </h2>
                <p>{recap.summary}</p>
              </section>

              <p className="reader-hint">
                <Icon name="touch_app" size={15} />
                Hover any line to see the slide it came from.
              </p>

              {recap.sections.map((section) => (
                <section key={section.id} className="recap-section">
                  <h2 className="recap-heading">{section.heading}</h2>
                  <ul className="claims">
                    {section.points.map((p) => (
                      <Claim key={p.id} id={p.id} citations={p.citations} confidence={p.confidence}>
                        {p.text}
                      </Claim>
                    ))}
                  </ul>
                </section>
              ))}

              {recap.keyTerms?.length > 0 && (
                <section className="recap-section">
                  <h2 className="recap-heading">Key terms</h2>
                  <dl className="terms">
                    {recap.keyTerms.map((t) => (
                      <div key={t.term} className="term">
                        <dt>{t.term}</dt>
                        <dd>{t.definition}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}

              <aside className="shared-cta">
                <div>
                  <h2>Got your own lecture notes?</h2>
                  <p>Upload a deck and get a recap like this one, with every line traceable to a slide.</p>
                </div>
                <Link to="/signup" className="btn btn-primary">
                  Try SmartRecap
                  <Icon name="arrow_forward" size={18} />
                </Link>
              </aside>
            </div>

            <aside className="source-rail" aria-label="Source passages">
              <p className="rail-title">From {material.fileName}</p>
              {chunks.map((c) => (
                <SourceCard key={c.id} chunk={c} />
              ))}
            </aside>

            {!reduced && <CitationRibbon containerRef={readerRef} />}
          </div>
        </CitationProvider>
      </main>
    </div>
  );
}

function SharedBar() {
  return (
    <header className="study-bar">
      <div className="shell study-bar-inner">
        <Brand />
        <span className="chip shared-chip">
          <Icon name="visibility" size={14} />
          Read-only
        </span>
        <span className="grow" />
        <Link to="/signup" className="btn btn-primary btn-sm">
          Make your own
        </Link>
      </div>
    </header>
  );
}
