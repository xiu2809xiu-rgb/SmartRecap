import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import AuthImage from '../components/AuthImage.jsx';
import { useStore } from '../lib/store.jsx';
import { useJobs } from '../components/jobs.jsx';
import { enableCompletionNotifications } from '../lib/notifications.js';
import { usePrefs } from '../lib/prefs.jsx';
import { StudyShell } from '../components/layout/Shells.jsx';
import { CitationProvider, Claim, SourceCard, CitationRibbon } from '../components/Citations.jsx';
import AskPanel from '../components/AskPanel.jsx';
import NarrationButton from '../components/NarrationButton.jsx';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import NormalNotes from '../components/NormalNotes.jsx';
import { buildDocumentNotes } from '../lib/documentNotes.js';
import { Icon, Spinner, Empty, Modal, CopyButton, useToast } from '../components/ui.jsx';
import { toMarkdown, toAnkiCsv, printRecap } from '../lib/exporters.js';
import { formatDuration } from '../lib/format.js';
import { languageLabel, langAttr } from '../lib/languages.js';
import FadeContent from '../reactbits/FadeContent.jsx';
import './recap.css';

const QUIZ_LEVELS = [
  { value: 'easy', title: 'Easy', icon: 'school', body: 'Build confidence with clear concepts and straightforward applications.' },
  { value: 'medium', title: 'Medium', icon: 'psychology', body: 'Apply ideas, compare concepts, and reason through realistic situations.' },
  { value: 'hard', title: 'Hard', icon: 'local_fire_department', body: 'Gemini drafts, GPT-5.6 Sol refines, and OpenAI performs the final conceptual-quality audit.' },
];
const QUIZ_TYPES = [
  { value: 'single', label: 'Single', icon: 'radio_button_checked' },
  { value: 'multi', label: 'Multi', icon: 'checklist' },
  { value: 'short', label: 'Short', icon: 'edit_note' },
];

export default function Recap() {
  const { id } = useParams();
  const { materialById, upsertMaterial } = useStore();
  const { registerJob } = useJobs();
  const { reduced } = usePrefs();
  const toast = useToast();

  const cached = materialById(id);
  const [material, setMaterial] = useState(cached ?? null);
  const [error, setError] = useState(null);
  const [askOpen, setAskOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [share, setShare] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [quizDifficulty, setQuizDifficulty] = useState('medium');
  const [quizCount, setQuizCount] = useState(10);
  const [quizTypes, setQuizTypes] = useState(['single']);
  const [quizBusy, setQuizBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [viewMode, setViewMode] = useState('recap');
  const [playMode, setPlayMode] = useState('solo');
  const readerRef = useRef(null);
  const quizBuilderRef = useRef(null);

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
  }, [id, upsertMaterial]);

  useEffect(() => {
    if (cached) setMaterial(cached);
  }, [cached]);

  const chunks = useMemo(() => material?.chunks ?? [], [material]);
  const documentSections = useMemo(() => buildDocumentNotes(chunks), [chunks]);

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
  // Keep the requested language separate from whether translation actually
  // completed so assistive technology receives the language on screen.
  const askedForTranslation = !!material.language && material.language !== 'en';
  const readsAsTranslated = askedForTranslation && material.pipeline?.translation?.translated === true;
  const quiz = material.quiz ?? { status: 'not_generated', questions: [] };
  const quizReady = quiz.questions?.length > 0 && quiz.status !== 'generating' && quiz.status !== 'failed';
  const quizGenerating = quiz.status === 'generating' || quiz.generationStatus === 'generating';

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

  const createIllustrations = async () => {
    setImageBusy(true);
    try {
      const illustrations = await api.illustrations.create(material.id, {
        count: 2,
        regenerate: Boolean(material.illustrations?.length),
      });
      const updated = { ...material, illustrations };
      setMaterial(updated);
      upsertMaterial(updated);
      toast.success('Created source-derived study visuals. Your text notes remain the source of truth.');
    } catch (error) {
      toast.error(error.message ?? 'Could not create study visuals.');
    } finally {
      setImageBusy(false);
    }
  };

  const generateQuiz = async () => {
    setQuizBusy(true);
    void enableCompletionNotifications();
    try {
      const response = await api.quiz.generate(material.id, {
        difficulty: quizDifficulty,
        questionCount: quizCount,
        questionTypes: quizTypes,
      });
      const optimisticQuiz = quizReady
        ? { ...quiz, generationStatus: 'generating', requestedDifficulty: quizDifficulty }
        : { status: 'generating', generationStatus: 'generating', questions: [], requestedDifficulty: quizDifficulty };
      const updated = { ...material, quiz: optimisticQuiz };
      setMaterial(updated);
      upsertMaterial(updated);
      registerJob({
        id: response.jobId,
        materialId: material.id,
        kind: 'quiz',
        title: material.title,
        stage: 'queued',
        stageLabel: quizDifficulty === 'hard' ? 'Gemini drafting; GPT-5.6 Sol refining; OpenAI auditing' : 'Gemini creating conceptual questions',
        progress: 0,
      });
      toast.info('Quiz generation started. Keep studying—we will notify you when it is ready.');
    } catch (e) {
      toast.error(e.message ?? 'Could not start quiz generation.');
    } finally {
      setQuizBusy(false);
    }
  };

  return (
    <StudyShell
      title={material.title}
      subtitle={`${material.module} · ${material.pageCount} pages · ${recap.readMinutes} min read`}
      subtitleAccessory={
        <div className="study-meta-accessory" aria-label="Notes view">
          <button type="button" title="Smart Recap view" aria-label="Show Smart Recap view" className={viewMode === 'recap' ? 'is-on' : ''} onClick={() => setViewMode('recap')} aria-pressed={viewMode === 'recap'}>
            <Icon name="auto_awesome" size={13} /><span className="view-label">Recap</span>
          </button>
          <button type="button" title="Normal notes view" aria-label="Show normal notes view" className={viewMode === 'document' ? 'is-on' : ''} onClick={() => setViewMode('document')} aria-pressed={viewMode === 'document'}>
            <Icon name="article" size={13} /><span className="view-label">Normal notes</span>
          </button>
        </div>
      }
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
          <Link to={`/app/material/${material.id}/practice`} className="btn btn-ghost btn-sm">
            <Icon name="code" size={17} />
            <span className="action-label">Practice</span>
          </Link>
          {quizReady && !quizGenerating ? (
            <>
              <Link to={`/app/material/${material.id}/quiz?quizId=${encodeURIComponent(quiz.id)}`} className="btn btn-primary btn-sm">
                <Icon name="person" size={17} />
                Solo quiz
              </Link>
              <Link to={`/app/material/${material.id}/match?quizId=${encodeURIComponent(quiz.id)}`} className="btn btn-ghost btn-sm">
                <Icon name="groups" size={17} />
                <span className="action-label">Multiplayer</span>
              </Link>
            </>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => quizBuilderRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })}
              disabled={quizGenerating}
            >
              {quizGenerating ? <Spinner size={16} /> : <Icon name="quiz" size={17} />}
              {quizGenerating ? 'Creating quiz' : 'Create quiz'}
            </button>
          )}
        </>
      }
    >
      <div className={`shell recap-shell ${askOpen ? 'ask-open' : ''} ${viewMode === 'document' ? 'is-document-view' : ''}`}>
        {viewMode === 'document' ? (
          <NormalNotes material={material} sections={documentSections} />
        ) : (
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
                  <p className="tldr-summary">{recap.summary}</p>
                  <ErrorBoundary scope="Read-aloud">
                    <NarrationButton materialId={id} />
                  </ErrorBoundary>
                </section>
              </FadeContent>

              <section className="study-visuals" aria-labelledby="study-visuals-title">
                <header>
                  <div>
                    <p className="section-kicker"><Icon name="image" size={16} />Optional visual memory aids</p>
                    <h2 id="study-visuals-title">Study visuals</h2>
                  </div>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={createIllustrations} disabled={imageBusy || api.mode !== 'live'}>
                    {imageBusy ? <Spinner size={16} /> : <Icon name="auto_awesome" size={17} />}
                    {material.illustrations?.length ? 'Regenerate visuals' : 'Create visuals'}
                  </button>
                </header>
                {material.illustrations?.length ? (
                  <div className="study-visual-grid">
                    {material.illustrations.map((illustration) => (
                      <figure key={illustration.id}>
                        <AuthImage path={illustration.path} alt={`Educational illustration for ${illustration.topic}`} />
                        <figcaption><strong>{illustration.topic}</strong><span>{illustration.provider} · {illustration.model}</span></figcaption>
                      </figure>
                    ))}
                  </div>
                ) : (
                  <p>Generate up to two optional illustrations from sanitized recap concepts. No raw file, filename, citation, or secret is sent to the image provider.</p>
                )}
              </section>

              <p className="reader-hint">
                <Icon name="touch_app" size={15} />
                Hover or select a note to reveal its exact source.
              </p>

              {recap.sections
                .filter((section) => section.id === 'takeaways')
                .map((section) => (
                  <section key={section.id} className="recap-section takeaway-section">
                    <header className="takeaway-head">
                      <div>
                        <p className="section-kicker">
                          <Icon name="stars" size={16} />
                          Essential ideas
                        </p>
                        <h2 className="recap-heading takeaway-heading">{section.heading}</h2>
                      </div>
                      <p className="section-lede">The most important concepts to remember from this material.</p>
                    </header>
                    <ul className="takeaway-grid">
                      {section.points.map((p) => (
                        <Claim key={p.id} id={p.id} citations={p.citations} confidence={p.confidence}>
                          {p.text}
                        </Claim>
                      ))}
                    </ul>
                  </section>
                ))}

              {recap.sections
                .filter((section) => section.id !== 'takeaways')
                .map((section, index) => (
                  <section key={section.id} className="recap-section topic-card">
                    <header className="topic-card-head">
                      <span className="topic-index" aria-hidden="true">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <div className="topic-heading-wrap">
                        <p className="topic-eyebrow">Study topic</p>
                        <h2 className="recap-heading">{section.heading}</h2>
                      </div>
                      <span className="topic-count">
                        {section.points.length} {section.points.length === 1 ? 'point' : 'points'}
                      </span>
                    </header>
                    <ul className="claims topic-claims">
                      {section.points.map((p) => (
                        <Claim key={p.id} id={p.id} citations={p.citations} confidence={p.confidence}>
                          {p.text}
                        </Claim>
                      ))}
                    </ul>
                  </section>
                ))}

              {recap.keyTerms?.length > 0 && (
                <section className="recap-section terms-section">
                  <header className="terms-head">
                    <div>
                      <p className="section-kicker">
                        <Icon name="dictionary" size={16} />
                        Quick reference
                      </p>
                      <h2 className="recap-heading">Key terms</h2>
                    </div>
                    <p className="section-lede">Core vocabulary, explained in plain language.</p>
                  </header>
                  <dl className="terms">
                    {recap.keyTerms.map((t) => (
                      <div key={t.term} className="term">
                        <dt>{t.term}</dt>
                        <dd>{t.definition}</dd>
                        {t.citations?.length > 0 && (
                          <div className="term-sources" aria-label={`Sources for ${t.term}`}>
                            {t.citations.map((c) => (
                              <a key={c} href={`#src-${c}`} className="cite term-cite">
                                {chunks.find((x) => x.id === c)?.label ?? c}
                              </a>
                            ))}
                          </div>
                        )}
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

              <section ref={quizBuilderRef} className="recap-section quiz-builder-card" aria-labelledby="quiz-builder-title">
                <div className="quiz-builder-copy">
                  <p className="section-kicker">
                    <Icon name="quiz" size={16} />
                    Test your understanding
                  </p>
                  <h2 id="quiz-builder-title">Create a quiz from these notes</h2>
                  <p>
                    Questions focus on applying concepts and reasoning—not remembering slide numbers, page labels, or exact wording.
                  </p>
                </div>

                {quizGenerating && (
                  <div className="quiz-generation-status" role="status">
                    <Spinner size={17} />
                    <span>
                      {quiz.requestedDifficulty === 'hard'
                        ? 'Gemini is drafting, GPT-5.6 Sol is refining, and OpenAI is auditing your hard quiz.'
                        : 'Gemini is building your conceptual quiz.'}
                    </span>
                  </div>
                )}

                <div className="difficulty-grid" aria-label="Quiz difficulty">
                  {QUIZ_LEVELS.map((level) => (
                    <button
                      key={level.value}
                      type="button"
                      className={`difficulty-card ${quizDifficulty === level.value ? 'is-on' : ''}`}
                      onClick={() => setQuizDifficulty(level.value)}
                      aria-pressed={quizDifficulty === level.value}
                      disabled={quizGenerating || quizBusy}
                    >
                      <span className="difficulty-icon"><Icon name={level.icon} size={20} /></span>
                      <strong>{level.title}</strong>
                      <span>{level.body}</span>
                    </button>
                  ))}
                </div>

                {quizReady && (
                  <div className="quiz-play-modes" aria-label="Quiz play mode">
                    <button type="button" className={playMode === 'solo' ? 'is-on' : ''} onClick={() => setPlayMode('solo')} aria-pressed={playMode === 'solo'}>
                      <span><Icon name="person" size={20} /></span><strong>Solo quiz</strong><small>Study at your own pace with instant explanations.</small>
                    </button>
                    <button type="button" className={playMode === 'match' ? 'is-on' : ''} onClick={() => setPlayMode('match')} aria-pressed={playMode === 'match'}>
                      <span><Icon name="groups" size={20} /></span><strong>Matchmaking</strong><small>Create or join a live room using this quiz.</small>
                    </button>
                  </div>
                )}

                <div className="quiz-builder-foot">
                  <div className="quiz-generation-options">
                    <div className="quiz-count-picker">
                      <span>Questions</span>
                      {[5, 10, 15].map((count) => (
                        <button
                          key={count}
                          type="button"
                          className={quizCount === count ? 'is-on' : ''}
                          onClick={() => setQuizCount(count)}
                          disabled={quizGenerating || quizBusy}
                          aria-pressed={quizCount === count}
                        >
                          {count}
                        </button>
                      ))}
                    </div>
                    <div className="quiz-count-picker quiz-type-picker">
                      <span>Types</span>
                      {QUIZ_TYPES.map((type) => {
                        const selected = quizTypes.includes(type.value);
                        return <button key={type.value} type="button" className={selected ? 'is-on' : ''} aria-pressed={selected} title={type.label} disabled={quizGenerating || quizBusy} onClick={() => setQuizTypes((current) => selected ? (current.length === 1 ? current : current.filter((item) => item !== type.value)) : [...current, type.value])}><Icon name={type.icon} size={15} />{type.label}</button>;
                      })}
                    </div>
                  </div>
                  <div className="quiz-builder-actions">
                    {quizReady && (
                      <Link to={playMode === 'match' ? `/app/material/${material.id}/match?quizId=${encodeURIComponent(quiz.id)}` : `/app/material/${material.id}/quiz?quizId=${encodeURIComponent(quiz.id)}`} className="btn btn-ghost">
                        <Icon name={playMode === 'match' ? 'groups' : 'play_arrow'} size={18} />
                        {playMode === 'match' ? 'Find a match' : 'Start solo quiz'}
                      </Link>
                    )}
                    <button className="btn btn-primary" onClick={generateQuiz} disabled={quizGenerating || quizBusy}>
                      {quizGenerating || quizBusy ? <Spinner size={17} /> : <Icon name="auto_awesome" size={18} />}
                      {quizGenerating ? 'Creating quiz' : quizReady ? 'Generate a new quiz' : 'Generate quiz'}
                    </button>
                  </div>
                </div>

                {quizReady && (
                  <p className="quiz-ready-meta">
                    <Icon name="verified" size={16} />
                    Current quiz: {quiz.questionCount ?? quiz.questions.length} {quiz.difficulty} questions
                    {quiz.providers?.length ? ` · ${quiz.providers.map((provider) => provider.model).join(' + ')}` : ''}
                  </p>
                )}
              </section>

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
        )}

        <ErrorBoundary scope="The Ask panel">
          <AskPanel material={material} open={askOpen} onClose={() => setAskOpen(false)} />
        </ErrorBoundary>
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
