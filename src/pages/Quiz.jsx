import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.jsx';
import { usePrefs } from '../lib/prefs.jsx';
import { StudyShell } from '../components/layout/Shells.jsx';
import { Icon, Spinner, Empty, ProgressBar, Modal, useToast } from '../components/ui.jsx';
import BlurText from '../reactbits/BlurText.jsx';
import './quiz.css';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * The quiz.
 *
 * Two rules shape this screen:
 *  - A question the model could not settle from the source is presented, but
 *    labelled and excluded from the score. Your percentage should measure
 *    whether you learned the deck, not whether you guessed what the model meant.
 *  - `?topics=` filters to weak topics only, which is how "retry what you got
 *    wrong" from the results screen works without regenerating anything.
 */
export default function Quiz() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { materialById, upsertMaterial, addAttempt } = useStore();
  const { reduced } = usePrefs();

  const cached = materialById(id);
  const [material, setMaterial] = useState(cached ?? null);
  const [error, setError] = useState(null);

  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [selected, setSelected] = useState(null);
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const startedAt = useRef(Date.now());

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

  const topicFilter = params.get('topics');

  const questions = useMemo(() => {
    const all = material?.quiz?.questions ?? [];
    if (!topicFilter) return all;
    const wanted = new Set(topicFilter.split(',').map((t) => t.trim().toLowerCase()));
    const filtered = all.filter((q) => wanted.has(q.topic.toLowerCase()));
    return filtered.length ? filtered : all;
  }, [material, topicFilter]);

  const question = questions[index];
  const isLast = index === questions.length - 1;
  const scored = questions.filter((q) => q.verified).length;
  const correctSoFar = questions
    .slice(0, index + (checked ? 1 : 0))
    .filter((q) => q.verified && answers[q.id] === q.answer).length;

  // Keyboard: 1-4 picks an option, Enter checks then advances.
  useEffect(() => {
    const onKey = (e) => {
      if (!question) return;
      if (/^[1-9]$/.test(e.key) && !checked) {
        const i = Number(e.key) - 1;
        if (i < question.options.length) setSelected(i);
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!checked && selected != null) check();
        else if (checked) advance();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const check = () => {
    if (selected == null) return;
    setAnswers((a) => ({ ...a, [question.id]: selected }));
    setChecked(true);
  };

  const advance = async () => {
    if (!isLast) {
      setIndex((i) => i + 1);
      setSelected(null);
      setChecked(false);
      return;
    }
    setSubmitting(true);
    try {
      const attempt = await api.quiz.submit({
        materialId: id,
        answers: { ...answers, [question.id]: selected },
        durationMs: Date.now() - startedAt.current,
      });
      addAttempt(attempt);
      navigate(`/app/material/${id}/results/${attempt.id}`, { replace: true });
    } catch (e) {
      toast.error(e.message ?? 'Could not save your attempt.');
      setSubmitting(false);
    }
  };

  if (error) {
    return (
      <StudyShell title="Quiz unavailable">
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
      <StudyShell title="Loading quiz">
        <div className="shell quiz-loading" role="status">
          <Spinner size={22} />
          <span>Preparing your questions…</span>
        </div>
      </StudyShell>
    );
  }

  if (!question) {
    return (
      <StudyShell title={material.title} backTo={`/app/material/${id}`}>
        <div className="shell">
          <Empty
            icon="quiz"
            title="No quiz for this material"
            body="No questions could be written that your material clearly answers. Uploading a fuller version of the file, or re-running it in Deep revision mode, usually fixes it."
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

  const chunkLabels = (question.citations ?? [])
    .map((c) => material.chunks?.find((x) => x.id === c)?.label)
    .filter(Boolean);

  return (
    <StudyShell
      title={material.title}
      subtitle={topicFilter ? `Retrying: ${topicFilter}` : 'Knowledge check'}
      backTo={`/app/material/${id}`}
      actions={
        <button className="btn btn-ghost btn-sm" onClick={() => setConfirmExit(true)}>
          <Icon name="close" size={17} />
          <span className="action-label">End quiz</span>
        </button>
      }
    >
      <div className="shell quiz">
        <div className="quiz-progress">
          <ProgressBar value={((index + (checked ? 1 : 0)) / questions.length) * 100} label="Quiz progress" />
          <div className="quiz-meter">
            <span className="num">
              Question {index + 1} of {questions.length}
            </span>
            <span className="num">
              {correctSoFar} correct{scored < questions.length ? ` · ${scored} scored` : ''}
            </span>
          </div>
        </div>

        <article className="quiz-card panel-solid" key={question.id}>
          <div className="quiz-tags">
            <span className="chip">{question.topic}</span>
            <span className="chip">
              {['Recall', 'Applied', 'Stretch'][question.difficulty - 1] ?? 'Applied'}
            </span>
            {!question.verified && (
              <span className="chip chip-warn">
                <Icon name="info" size={13} />
                Not scored
              </span>
            )}
          </div>

          <h2 className="quiz-prompt">
            {reduced ? question.prompt : <BlurText text={question.prompt} animateBy="words" delay={26} direction="bottom" />}
          </h2>

          {!question.verified && (
            <p className="quiz-unverified">
              Your material does not clearly answer this one, so it does not count toward your score. Answer it
              anyway — the explanation still tells you what your slides do and do not settle.
            </p>
          )}

          <ul className="options" role="radiogroup" aria-label="Answer options">
            {question.options.map((option, i) => {
              const isPicked = selected === i;
              const isRight = i === question.answer;
              const state = !checked ? (isPicked ? 'picked' : 'idle') : isRight ? 'right' : isPicked ? 'wrong' : 'idle';
              return (
                <li key={i}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isPicked}
                    className={`option is-${state}`}
                    onClick={() => !checked && setSelected(i)}
                    disabled={checked}
                  >
                    <span className="option-key num">{LETTERS[i]}</span>
                    <span className="option-text">{option}</span>
                    {checked && isRight && <Icon name="check_circle" size={20} fill />}
                    {checked && isPicked && !isRight && <Icon name="cancel" size={20} fill />}
                  </button>
                </li>
              );
            })}
          </ul>

          {checked && (
            <div className={`explain ${selected === question.answer ? 'is-right' : 'is-wrong'}`}>
              <p className="explain-verdict">
                <Icon name={selected === question.answer ? 'check_circle' : 'cancel'} size={18} fill />
                {selected === question.answer ? 'Correct' : `The answer is ${LETTERS[question.answer]}`}
              </p>
              <p>{question.explanation}</p>
              {chunkLabels.length > 0 && (
                <p className="explain-cites">
                  From{' '}
                  {chunkLabels.map((l, i) => (
                    <span key={l} className="cite">
                      {l}
                      {i < chunkLabels.length - 1 ? '' : ''}
                    </span>
                  ))}
                </p>
              )}
            </div>
          )}

          <div className="quiz-foot">
            <p className="quiz-hint">
              {checked ? 'Press Enter to continue' : 'Press 1–4 to pick, Enter to check'}
            </p>
            {!checked ? (
              <button className="btn btn-primary" onClick={check} disabled={selected == null}>
                Check answer
              </button>
            ) : (
              <button className="btn btn-primary" onClick={advance} disabled={submitting}>
                {submitting ? <Spinner size={17} /> : null}
                {isLast ? 'See results' : 'Next question'}
                {!isLast && <Icon name="arrow_forward" size={18} />}
              </button>
            )}
          </div>
        </article>
      </div>

      <Modal
        open={confirmExit}
        onClose={() => setConfirmExit(false)}
        title="End this quiz?"
        footer={
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmExit(false)}>
              Keep going
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => navigate(`/app/material/${id}`)}>
              End without saving
            </button>
          </>
        }
      >
        <p>
          You are {index + 1} of {questions.length} questions in. Ending now discards this attempt — it will not appear
          in your progress or affect your mastery scores.
        </p>
      </Modal>
    </StudyShell>
  );
}
