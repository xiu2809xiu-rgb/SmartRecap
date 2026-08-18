import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.jsx';
import { StudyShell } from '../components/layout/Shells.jsx';
import { Icon, Spinner, Empty, useToast } from '../components/ui.jsx';
import useRunner from '../practice/useRunner.js';
import './practice.css';

// CodeMirror is not on the critical path for any other screen, and a student
// who never opens practice should never download it.
const CodeEditor = lazy(() => import('../practice/CodeEditor.jsx'));

/**
 * Practice: write the code the lecture was about, next to the recap of it.
 *
 * A separate route rather than a third column on the reader. The reader already
 * collapses to one column at 940px and its Ask panel is a fixed 420px rail that
 * only gets compensated for above 1400px — an editor wedged into that has
 * nowhere to be. It also would have desynced the citation ribbon, which
 * measures absolute positions and re-measures on scroll.
 *
 * Exercises are generated from the student's own material and cite it, so this
 * is not a code playground that happens to sit near some notes. If the upload
 * does not teach programming, the page says so rather than inventing FizzBuzz.
 */
export default function Practice() {
  const { id } = useParams();
  const { materialById } = useStore();
  const toast = useToast();
  const { run, state } = useRunner();

  const [material, setMaterial] = useState(materialById(id) ?? null);
  const [practice, setPractice] = useState(null);
  const [error, setError] = useState(null);
  const [index, setIndex] = useState(0);
  // Keyed by exercise id so switching exercises and coming back does not
  // discard what the student wrote.
  const [drafts, setDrafts] = useState({});
  const [results, setResults] = useState({});
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [full, set] = await Promise.all([api.materials.get(id), api.practice.get(id)]);
        if (cancelled) return;
        setMaterial(full);
        setPractice(set);
      } catch (e) {
        if (!cancelled) setError(e.message ?? 'Could not load practice for this material.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const exercises = practice?.exercises ?? [];
  const exercise = exercises[index] ?? null;
  const code = exercise ? (drafts[exercise.id] ?? exercise.starter) : '';
  const result = exercise ? results[exercise.id] : null;

  const chunkLabel = useCallback(
    (chunkId) => material?.chunks?.find((c) => c.id === chunkId)?.label ?? chunkId,
    [material],
  );

  const sources = useMemo(() => {
    if (!exercise || !material?.chunks) return [];
    return exercise.citations.map((c) => material.chunks.find((chunk) => chunk.id === c)).filter(Boolean);
  }, [exercise, material]);

  const onRun = async () => {
    if (!exercise) return;
    // Clear the previous result first. Loading Python takes seconds on a first
    // run, and leaving the last score on screen through that means a student
    // reads a stale "1 of 3 passing" as the answer to the code they just
    // wrote. Verified: without this the old result sits there for the whole
    // run, including the ten seconds before a runaway loop is killed.
    setResults((prev) => ({ ...prev, [exercise.id]: null }));
    const outcome = await run({ language: exercise.language, code, tests: exercise.tests });
    setResults((prev) => ({ ...prev, [exercise.id]: outcome }));
    if (outcome.ok && outcome.tests.length && outcome.tests.every((t) => t.pass)) {
      toast.success('All tests passed.');
    }
  };

  const onReset = () => {
    if (!exercise) return;
    setDrafts((prev) => ({ ...prev, [exercise.id]: exercise.starter }));
    setResults((prev) => ({ ...prev, [exercise.id]: null }));
  };

  const goTo = (next) => {
    setIndex(next);
    setShowHint(false);
  };

  /* ------------------------------------------------------------- states */

  if (error) {
    return (
      <StudyShell title="Practice" backTo={`/app/material/${id}`}>
        <div className="shell">
          <Empty
            icon="error"
            title="Practice is not available"
            body={error}
            action={
              <Link to={`/app/material/${id}`} className="btn btn-primary">
                Back to the recap
              </Link>
            }
          />
        </div>
      </StudyShell>
    );
  }

  if (!practice) {
    return (
      <StudyShell title="Practice" backTo={`/app/material/${id}`}>
        <div className="shell practice-loading" role="status">
          <Spinner size={22} />
          <span>Working out what there is to practise…</span>
        </div>
      </StudyShell>
    );
  }

  if (!exercises.length) {
    return (
      <StudyShell title="Practice" backTo={`/app/material/${id}`}>
        <div className="shell">
          <Empty
            icon="code_off"
            title="Nothing here to practise in code"
            body={
              practice.reason ??
              'This material does not teach programming, so writing code against it would not help you revise it.'
            }
            action={
              <Link to={`/app/material/${id}/quiz`} className="btn btn-primary">
                <Icon name="quiz" size={18} />
                Take the quiz instead
              </Link>
            }
          />
        </div>
      </StudyShell>
    );
  }

  const passed = result?.tests?.filter((t) => t.pass).length ?? 0;
  const busy = state.status === 'running';

  return (
    <StudyShell
      title={material?.title ?? 'Practice'}
      subtitle={`Exercise ${index + 1} of ${exercises.length} · ${exercise.concept}`}
      backTo={`/app/material/${id}`}
      wide
      actions={
        <Link to={`/app/material/${id}`} className="btn btn-ghost btn-sm">
          <Icon name="article" size={17} />
          <span className="action-label">Recap</span>
        </Link>
      }
    >
      <div className="shell practice">
        <div className="practice-grid">
          {/* ------------------------------------------------------ brief */}
          <div className="practice-brief">
            <nav className="practice-tabs" aria-label="Exercises">
              {exercises.map((e, i) => (
                <button
                  key={e.id}
                  type="button"
                  className={`practice-tab ${i === index ? 'is-on' : ''} ${
                    results[e.id]?.tests?.length && results[e.id].tests.every((t) => t.pass) ? 'is-done' : ''
                  }`}
                  onClick={() => goTo(i)}
                  aria-current={i === index}
                >
                  {results[e.id]?.tests?.length && results[e.id].tests.every((t) => t.pass) ? (
                    <Icon name="check_circle" size={15} fill />
                  ) : (
                    <span className="practice-tab-num num">{i + 1}</span>
                  )}
                  <span className="truncate">{e.title}</span>
                </button>
              ))}
            </nav>

            <h1 className="practice-title">{exercise.title}</h1>
            <p className="practice-lede">{exercise.brief}</p>

            {sources.length > 0 && (
              <div className="practice-sources">
                <p className="practice-sources-head">
                  <Icon name="link" size={15} />
                  From your material
                </p>
                {sources.map((chunk) => (
                  <article key={chunk.id} className="practice-source">
                    <span className="cite">{chunkLabel(chunk.id)}</span>
                    <p>{chunk.text.slice(0, 320)}</p>
                  </article>
                ))}
              </div>
            )}

            {exercise.hint && (
              <div className="practice-hint">
                {showHint ? (
                  <p>
                    <Icon name="lightbulb" size={16} />
                    {exercise.hint}
                  </p>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowHint(true)}>
                    <Icon name="lightbulb" size={16} />
                    Show a hint
                  </button>
                )}
              </div>
            )}
          </div>

          {/* ----------------------------------------------------- editor */}
          <div className="practice-work">
            <div className="practice-bar">
              <span className="chip practice-lang">{exercise.language === 'javascript' ? 'JavaScript' : 'Python'}</span>
              <div className="practice-bar-actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={onReset} disabled={busy}>
                  <Icon name="refresh" size={16} />
                  Reset
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={onRun} disabled={busy}>
                  {busy ? <Spinner size={16} /> : <Icon name="play_arrow" size={18} fill />}
                  {busy ? (state.phase === 'loading-runtime' ? 'Starting Python…' : 'Running…') : 'Run tests'}
                </button>
              </div>
            </div>

            <div className="practice-editor">
              <Suspense
                fallback={
                  <div className="practice-editor-loading" role="status">
                    <Spinner size={20} />
                    <span>Loading the editor…</span>
                  </div>
                }
              >
                <CodeEditor
                  value={code}
                  language={exercise.language}
                  onChange={(next) => setDrafts((prev) => ({ ...prev, [exercise.id]: next }))}
                />
              </Suspense>
            </div>

            <div className="practice-output" aria-live="polite">
              {!result && !busy && (
                <p className="practice-output-idle">
                  <Icon name="terminal" size={15} />
                  Write your answer, then run the tests. Nothing you type here leaves your browser.
                </p>
              )}

              {result?.error && (
                <p className={`practice-error ${result.timedOut ? 'is-timeout' : ''}`}>
                  <Icon name={result.timedOut ? 'timer_off' : 'error'} size={15} />
                  {result.error}
                </p>
              )}

              {result?.stdout ? <pre className="practice-stdout">{result.stdout}</pre> : null}

              {result?.tests?.length > 0 && (
                <>
                  <p className="practice-score">
                    <span className={passed === result.tests.length ? 'is-pass' : 'is-fail'}>
                      <Icon name={passed === result.tests.length ? 'check_circle' : 'cancel'} size={16} fill />
                      {passed} of {result.tests.length} tests passing
                    </span>
                  </p>
                  <ul className="practice-tests">
                    {result.tests.map((t, i) => (
                      <li key={i} className={t.pass ? 'is-pass' : 'is-fail'}>
                        <code className="practice-test-call">{t.call}</code>
                        <span className="practice-test-detail">
                          {t.pass ? (
                            <>gave {t.actual}</>
                          ) : (
                            <>
                              expected <b>{t.expect}</b>, got <b>{t.actual}</b>
                            </>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        </div>

        <nav className="practice-nav">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => goTo(index - 1)}
            disabled={index === 0}
          >
            <Icon name="arrow_back" size={18} />
            Previous
          </button>
          {index < exercises.length - 1 ? (
            <button type="button" className="btn btn-primary" onClick={() => goTo(index + 1)}>
              Next exercise
              <Icon name="arrow_forward" size={18} />
            </button>
          ) : (
            <Link to={`/app/material/${id}`} className="btn btn-primary">
              Back to the recap
              <Icon name="arrow_forward" size={18} />
            </Link>
          )}
        </nav>
      </div>
    </StudyShell>
  );
}
