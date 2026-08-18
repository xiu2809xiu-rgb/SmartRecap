import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.jsx';
import { usePrefs } from '../lib/prefs.jsx';
import { StudyShell } from '../components/layout/Shells.jsx';
import { CitationProvider, Claim, SourceCard, CitationRibbon } from '../components/Citations.jsx';
import AskPanel from '../components/AskPanel.jsx';
import { Icon, Spinner, Empty, Modal, CopyButton, useToast } from '../components/ui.jsx';
import { toMarkdown, toAnkiCsv, printRecap } from '../lib/exporters.js';
import { formatDuration } from '../lib/format.js';
import { languageLabel, langAttr } from '../lib/languages.js';
import FadeContent from '../reactbits/FadeContent.jsx';
import './recap.css';

export default function Recap() {
  const { id } = useParams();
  const { materialById, upsertMaterial } = useStore();
  const { reduced } = usePrefs();
  const toast = useToast();

  const cached = materialById(id);
  const [material, setMaterial] = useState(cached ?? null);
  const [error, setError] = useState(null);
  const [askOpen, setAskOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [share, setShare] = useState(null);
  const [sharing, setSharing] = useState(false);
  const readerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const full = await api.materials.get(id);
        if (cancelled) return;
        setMaterial(full);
        upsertMaterial(full);
      } catch (e) {
        if (!cancelled && !cached) setError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, cached, upsertMaterial]);

  const chunks = useMemo(() => material?.chunks ?? [], [material]);

  if (error) {
    return (
      <StudyShell title="Recap unavailable">
        <div className="shell">
          <Empty
            icon="error"
            title="That material is not in your library"
            body="It may have been deleted, or the link belongs to a different account."
            action={
              <Link to="/app" className="btn btn-primary">
                Back to library
              </Link>
            }
          />
        </div>
      </StudyShell>
    );
  }

  if (!material) {
    return (
      <StudyShell title="Loading recap">
        <div className="shell recap-loading" role="status">
          <Spinner size={22} />
          <span>Opening your recap…</span>
        </div>
      </StudyShell>
    );
  }

  const { recap } = material;
  // Two different questions. `askedForTranslation` decides whether to explain
  // anything to the reader; `readsAsTranslated` decides the `lang` attribute,
  // and that one has to follow the text that is actually on screen. Demo mode
  // calls no model, and a live translation call can fail — in both cases the
  // words below are still English, and telling a screen reader otherwise would
  // have it read English aloud in a Chinese voice.
  const askedForTranslation = !!material.language && material.language !== 'en';
  const readsAsTranslated = askedForTranslation && material.pipeline?.translation?.translated === true;

  const createShare = async () => {
    setSharing(true);
    try {
      const res = await api.share.create(material.id);
      setShare(res);
    } catch (e) {
      toast.error(e.message ?? 'Could not create a share link.');
    } finally {
      setSharing(false);
    }
  };

  return (
    <StudyShell
      title={material.title}
      subtitle={`${material.module} · ${material.pageCount} pages · ${recap.readMinutes} min read`}
      wide
      actions={
        <>
          <button className="btn btn-ghost btn-sm" onClick={() => setAskOpen((v) => !v)} aria-pressed={askOpen}>
            <Icon name="forum" size={17} />
            <span className="action-label">Ask</span>
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setExportOpen(true)}>
            <Icon name="ios_share" size={17} />
            <span className="action-label">Export</span>
          </button>
          <Link to={`/app/material/${material.id}/quiz`} className="btn btn-primary btn-sm">
            <Icon name="quiz" size={17} />
            Quiz me
          </Link>
        </>
      }
    >
      <div className={`shell recap-shell ${askOpen ? 'ask-open' : ''}`}>
        <CitationProvider chunks={chunks}>
          <div className="reader-grid" ref={readerRef}>
            {/* `lang` so a screen reader switches voice with the recap, and so
                the browser hyphenates and line-breaks it correctly. The source
                panel is not inside this column — it still quotes the original
                slides, in the original language. */}
            <div className="reader-col" lang={readsAsTranslated ? langAttr(material.language) : 'en'}>
              {askedForTranslation && (
                <p className="recap-flag">
                  <Icon name="translate" size={16} />
                  {readsAsTranslated
                    ? `Written and checked against your slides first, then translated into ${languageLabel(material.language)}. Every source quote below is the original wording.`
                    : material.demo
                      ? `Demo mode calls no model, so this stayed in English. On a live deployment it would be written in ${languageLabel(material.language)}.`
                      : `You asked for ${languageLabel(material.language)}, but the translation did not come back — this is the original wording. It is still fully checked against your slides.`}
                </p>
              )}

              {(material.sample || material.demo) && (
                <p className="recap-flag">
                  <Icon name="science" size={16} />
                  {material.sample
                    ? 'Sample material bundled with SmartRecap so the app has something to show before your first upload.'
                    : 'Made in demo mode — this is the sample recap, not one written from your own file.'}
                </p>
              )}

              <FadeContent duration={520} threshold={0.05}>
                <section className="tldr">
                  <h2 className="tldr-title">
                    <Icon name="bolt" size={19} />
                    The short version
                  </h2>
                  <p>{recap.summary}</p>
                </section>
              </FadeContent>

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
                        <dd>
                          {t.definition}
                          {t.citations?.map((c) => (
                            <a key={c} href={`#src-${c}`} className="cite term-cite">
                              {chunks.find((x) => x.id === c)?.label ?? c}
                            </a>
                          ))}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}

              {recap.examTips?.length > 0 && (
                <section className="recap-section">
                  <h2 className="recap-heading">What to watch for in the exam</h2>
                  <ul className="tips">
                    {recap.examTips.map((tip, i) => (
                      <li key={i}>
                        <Icon name="lightbulb" size={17} />
                        <span>{tip}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {recap.ungrounded?.length > 0 && (
                <section className="recap-section dropped">
                  <h2 className="recap-heading">
                    <Icon name="rule" size={20} />
                    Dropped from this recap
                  </h2>
                  <p className="dropped-lede">
                    The AI wrote these, but nothing in your file backs them up, so they are not part of the recap
                    above. They are shown rather than quietly deleted — knowing what the AI wanted to claim and could
                    not support is worth seeing.
                  </p>
                  <ul className="dropped-list">
                    {recap.ungrounded.map((u, i) => (
                      <li key={i}>
                        <p className="dropped-claim">{u.text}</p>
                        <p className="dropped-reason">{u.reason}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Transparency a student can act on: which AI wrote this, how much
                  of their file it actually read, and what it cost them. Token
                  counts and provider routing are ours to care about, not theirs
                  — those stay in the logs. */}
              {material.provider && (
                <section className="provenance">
                  <h2>How this recap was made</h2>
                  <dl>
                    <div>
                      <dt>Written by</dt>
                      <dd className="mono">{material.provider.model}</dd>
                    </div>
                    <div>
                      <dt>Time taken</dt>
                      <dd className="num">
                        {material.provider.latencyMs ? formatDuration(material.provider.latencyMs) : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>Passages read from your file</dt>
                      <dd className="num">{chunks.length}</dd>
                    </div>
                    <div>
                      <dt>Cost to you</dt>
                      <dd>{material.provider.costUsd > 0 ? `$${material.provider.costUsd.toFixed(2)}` : 'Free'}</dd>
                    </div>
                  </dl>
                </section>
              )}
            </div>

            <aside className="source-rail" aria-label="Source passages from your upload">
              <p className="rail-title">From {material.fileName}</p>
              {chunks.map((c) => (
                <SourceCard key={c.id} chunk={c} />
              ))}
            </aside>

            {!reduced && <CitationRibbon containerRef={readerRef} />}
          </div>
        </CitationProvider>

        <AskPanel material={material} open={askOpen} onClose={() => setAskOpen(false)} />
      </div>

      <Modal open={exportOpen} onClose={() => setExportOpen(false)} title="Export this recap">
        <div className="export-grid">
          <button
            className="export-option"
            onClick={() => {
              toMarkdown(material);
              setExportOpen(false);
              toast.success('Markdown file downloaded.');
            }}
          >
            <Icon name="description" size={22} />
            <strong>Markdown</strong>
            <span>Recap, key terms and the full quiz with answers. Drops straight into Notion or Obsidian.</span>
          </button>

          <button
            className="export-option"
            onClick={() => {
              const n = toAnkiCsv(material);
              setExportOpen(false);
              toast.success(`${n} cards exported for Anki.`);
            }}
          >
            <Icon name="style" size={22} />
            <strong>Anki CSV</strong>
            <span>Key terms and verified questions as front/back notes, tagged by module and topic.</span>
          </button>

          <button
            className="export-option"
            onClick={() => {
              setExportOpen(false);
              setTimeout(printRecap, 120);
            }}
          >
            <Icon name="print" size={22} />
            <strong>Print or PDF</strong>
            <span>Uses your browser's print dialogue. Sources are laid out as footnotes.</span>
          </button>

          <div className="export-option is-static">
            <Icon name="link" size={22} />
            <strong>Share a read-only link</strong>
            <span>Anyone with the link can read the recap and its sources. They cannot see your quiz scores.</span>
            {share ? (
              <div className="share-row">
                <input className="input" readOnly value={share.url} onFocus={(e) => e.target.select()} />
                <CopyButton value={share.url} />
              </div>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={createShare} disabled={sharing}>
                {sharing ? <Spinner size={15} /> : <Icon name="add_link" size={16} />}
                Create link
              </button>
            )}
          </div>
        </div>
      </Modal>
    </StudyShell>
  );
}
