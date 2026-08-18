import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.jsx';
import { usePrefs } from '../lib/prefs.jsx';
import { StudyShell } from '../components/layout/Shells.jsx';
import { Icon, Spinner, Empty, ProgressBar, Modal, useToast } from '../components/ui.jsx';
import BlurText from '../reactbits/BlurText.jsx';
import { TIME_LIMIT_SECONDS, pointsForAnswer, streakMultiplier } from '../lib/quizLogic.js';
import { questionType, exactSetMatch } from '../lib/quizScoring.js';
import './quiz.css';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const TYPE_OPTIONS = [
  { id: 'single', label: 'Single-select', description: 'Choose one answer', icon: 'radio_button_checked' },
  { id: 'multi', label: 'Multi-select', description: 'Choose every correct answer', icon: 'checklist' },
  { id: 'short', label: 'Short answer', description: 'Respond in your own words', icon: 'edit_note' },
];

function answerIsCorrect(question, answer) {
  if (questionType(question) === 'multi') return exactSetMatch(answer, question.answer);
  if (questionType(question) === 'short') return false;
  return answer === question.answer;
}

function normaliseSelection(question, selected) {
  if (questionType(question) === 'multi') return [...new Set(selected ?? [])].sort((a, b) => a - b);
  if (questionType(question) === 'short') return String(selected ?? '').trim();
  return selected;
}

function hasSelection(question, selected) {
  if (questionType(question) === 'multi') return Array.isArray(selected) && selected.length > 0;
  if (questionType(question) === 'short') return String(selected ?? '').trim().length > 0;
  return selected != null;
}

function initialSelection(question) {
  if (questionType(question) === 'multi') return [];
  if (questionType(question) === 'short') return '';
  return null;
}

function finalGameStats(questions, answers, timeByQuestion, judgements) {
  let points = 0;
  let streak = 0;
  let bestStreak = 0;

  for (const question of questions) {
    if (!question.verified) continue;
    const type = questionType(question);
    if (type === 'short' && judgements?.[question.id]?.verified !== true) continue;
    const correct =
      type === 'short' ? judgements[question.id].correct === true : answerIsCorrect(question, answers[question.id]);
    if (correct) {
      points += Math.round(
        pointsForAnswer(true, timeByQuestion[question.id] ?? 0) * streakMultiplier(streak),
      );
      streak += 1;
      bestStreak = Math.max(bestStreak, streak);
    } else {
      streak = 0;
    }
  }

  return { gamePoints: points, bestStreak };
}

/**
 * The quiz.
 *
 * `?topics=` and `?types=` independently filter the stored question bank. A
 * missing question type is treated as `single`, preserving old material. Short
 * answers are only recorded here; their authoritative judgement arrives with
 * the submitted attempt.
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
  const [selectedTypes, setSelectedTypes] = useState(() => new Set(TYPE_OPTIONS.map((type) => type.id)));
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [selected, setSelected] = useState(null);
  const [checked, setChecked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [matchLobby, setMatchLobby] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const [timeLeft, setTimeLeft] = useState(TIME_LIMIT_SECONDS);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [gamePoints, setGamePoints] = useState(0);
  const startedAt = useRef(null);
  const timeByQuestion = useRef({});
  const questionStartedAt = useRef(Date.now());

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
    // `cached` is intentionally excluded: upsertMaterial() updates the store
    // with a new reference after this request and would otherwise refetch forever.
  }, [id, upsertMaterial]);

  useEffect(() => {
    if (cached) setMaterial(cached);
  }, [cached]);

  const topicFilter = params.get('topics');
  const typeFilter = params.get('types');
  const matchId = params.get('match');
  const allQuestions = material?.quiz?.questions ?? [];

  useEffect(() => {
    if (!matchId) return undefined;
    let cancelled = false;
    const refresh = () => api.lobbies.get(matchId).then((value) => !cancelled && setMatchLobby(value)).catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, 1200);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [matchId]);

  const questions = useMemo(() => {
    let filtered = allQuestions;
    if (topicFilter) {
      const wantedTopics = new Set(topicFilter.split(',').map((topic) => topic.trim().toLowerCase()));
      const topicMatches = filtered.filter((item) => wantedTopics.has(String(item.topic || 'General').toLowerCase()));
      if (topicMatches.length) filtered = topicMatches;
    }
    if (typeFilter) {
      const wantedTypes = new Set(typeFilter.split(',').map((type) => type.trim().toLowerCase()));
      filtered = filtered.filter((item) => wantedTypes.has(questionType(item)));
    }
    return filtered;
  }, [allQuestions, topicFilter, typeFilter]);

  const question = questions[index];
  const isLast = index === questions.length - 1;
  const scored = questions.filter((item) => item.verified).length;
  const correctSoFar = questions
    .slice(0, index + (checked ? 1 : 0))
    .filter((item) => item.verified && answerIsCorrect(item, answers[item.id])).length;

  useEffect(() => {
    if (typeFilter && question && startedAt.current == null) startedAt.current = Date.now();
  }, [question, typeFilter]);

  const selectOption = (optionIndex) => {
    if (checked) return;
    if (questionType(question) === 'multi') {
      setSelected((current) => {
        const values = Array.isArray(current) ? current : [];
        return values.includes(optionIndex) ? values.filter((value) => value !== optionIndex) : [...values, optionIndex];
      });
    } else {
      setSelected(optionIndex);
    }
  };

  const check = async () => {
    if (checked || checking || !question || !hasSelection(question, selected)) return;
    const answer = normaliseSelection(question, selected);
    setAnswers((current) => ({ ...current, [question.id]: answer }));
    timeByQuestion.current[question.id] = timeLeft;
    const locallyCorrect = answerIsCorrect(question, answer);

    if (questionType(question) !== 'short' && question.verified) {
      if (locallyCorrect) {
        const earned = Math.round(pointsForAnswer(true, timeLeft) * streakMultiplier(streak));
        setGamePoints((points) => points + earned);
        setStreak((current) => {
          const next = current + 1;
          setBestStreak((best) => Math.max(best, next));
          return next;
        });
      } else {
        setStreak(0);
      }
    }
    setChecked(true);

    if (!matchId || questionType(question) === 'short') return;
    setChecking(true);
    try {
      const session = JSON.parse(localStorage.getItem(`smartrecap.lobby.${matchId}`) || 'null');
      if (!session) throw new Error('Your lobby session expired. Rejoin the party to score this answer.');
      const updated = await api.lobbies.answer(matchId, {
        playerId: session.playerId,
        reconnectToken: session.reconnectToken,
        questionId: question.id,
        correct: locallyCorrect,
        responseMs: Date.now() - questionStartedAt.current,
      });
      setMatchLobby(updated);
    } catch (matchError) {
      toast.error(matchError.message ?? 'Your answer was checked, but match points could not be updated.');
    } finally {
      setChecking(false);
    }
  };

  const advance = async () => {
    if (!isLast) {
      const nextQuestion = questions[index + 1];
      setIndex((current) => current + 1);
      setSelected(initialSelection(nextQuestion));
      setChecked(false);
      questionStartedAt.current = Date.now();
      return;
    }

    const finalAnswers = { ...answers, [question.id]: normaliseSelection(question, selected) };
    setSubmitting(true);
    try {
      const attempt = await api.quiz.submit({
        materialId: id,
        quizId: material.quiz?.id,
        answers: finalAnswers,
        questionIds: questions.map((item) => item.id),
        durationMs: Date.now() - (startedAt.current ?? Date.now()),
      });
      if (matchId) {
        try {
          const session = JSON.parse(localStorage.getItem(`smartrecap.lobby.${matchId}`) || 'null');
          if (session) {
            await api.lobbies.score(matchId, {
              playerId: session.playerId,
              reconnectToken: session.reconnectToken,
              attemptId: attempt.id,
              score: attempt.score,
            });
          }
        } catch (matchError) {
          toast.error(matchError.message ?? 'Your result was saved, but the match score could not be submitted.');
        }
      }
      addAttempt(attempt);
      const stats = finalGameStats(questions, finalAnswers, timeByQuestion.current, attempt.judgements);
      navigate(`/app/material/${id}/results/${attempt.id}${matchId ? `?match=${encodeURIComponent(matchId)}` : ''}`, { replace: true, state: stats });
    } catch (e) {
      toast.error(e.message ?? 'Could not save your attempt.');
      setSubmitting(false);
    }
  };

  // Keyboard: numbers select/toggle options; Enter checks then advances. Text
  // fields keep their native keyboard behaviour for short answers.
  useEffect(() => {
    const onKey = (event) => {
      if (!typeFilter || !question || event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (/^[1-9]$/.test(event.key) && !checked && questionType(question) !== 'short') {
        const optionIndex = Number(event.key) - 1;
        if (optionIndex < question.options.length) selectOption(optionIndex);
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!checked && hasSelection(question, selected)) check();
        else if (checked) advance();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (typeFilter) setTimeLeft(TIME_LIMIT_SECONDS);
  }, [question?.id, typeFilter]);

  useEffect(() => {
    if (!typeFilter || !question || checked) return undefined;
    if (timeLeft <= 0) {
      check();
      return undefined;
    }
    const timer = setTimeout(() => setTimeLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [question, checked, timeLeft, typeFilter]);

  const startQuiz = () => {
    if (!selectedTypes.size) return;
    const next = new URLSearchParams(params);
    next.set('types', TYPE_OPTIONS.filter((type) => selectedTypes.has(type.id)).map((type) => type.id).join(','));
    startedAt.current = Date.now();
    questionStartedAt.current = Date.now();
    navigate({ search: `?${next.toString()}` }, { replace: true });
  };

  const toggleType = (type) => {
    setSelectedTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
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

  if (!allQuestions.length) {
    const generating = material.quiz?.status === 'generating' || material.quiz?.generationStatus === 'generating';
    return (
      <StudyShell title={material.title} backTo={`/app/material/${id}`}>
        <div className="shell">
          <Empty
            icon={generating ? 'hourglass_top' : 'quiz'}
            title={generating ? 'Your quiz is being created' : 'Create your quiz after studying the notes'}
            body={
              generating
                ? 'You can continue browsing. SmartRecap will notify you when the questions are ready.'
                : 'Return to the recap to choose Easy, Medium, or Hard difficulty and generate conceptual questions from your material.'
            }
            action={
              <Link to={`/app/material/${id}`} className="btn btn-primary">
                {generating ? 'Continue studying' : 'Choose quiz difficulty'}
              </Link>
            }
          />
        </div>
      </StudyShell>
    );
  }

  if (!typeFilter) {
    return (
      <StudyShell
        title={material.title}
        subtitle={topicFilter ? `Retrying: ${topicFilter}` : 'Set up your knowledge check'}
        backTo={`/app/material/${id}`}
      >
        <div className="shell quiz quiz-setup-wrap">
          <section className="quiz-setup panel-solid">
            <span className="quiz-setup-icon"><Icon name="tune" size={24} /></span>
            <p className="eyebrow">Quiz setup</p>
            <h1>Which question types do you want?</h1>
            <p className="lede">Choose one or more. You can change the mix each time you practise.</p>
            <div className="quiz-type-list">
              {TYPE_OPTIONS.map((type) => (
                <label key={type.id} className={`quiz-type-choice ${selectedTypes.has(type.id) ? 'is-selected' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selectedTypes.has(type.id)}
                    onChange={() => toggleType(type.id)}
                  />
                  <span className="quiz-type-icon"><Icon name={type.icon} size={22} /></span>
                  <span>
                    <strong>{type.label}</strong>
                    <small>{type.description}</small>
                  </span>
                </label>
              ))}
            </div>
            <button className="btn btn-primary quiz-start" onClick={startQuiz} disabled={!selectedTypes.size}>
              Start quiz
              <Icon name="arrow_forward" size={18} />
            </button>
          </section>
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
            title="No questions match those filters"
            body="Choose a different question type or return to the recap."
            action={
              <button className="btn btn-primary" onClick={() => navigate({ search: topicFilter ? `?topics=${encodeURIComponent(topicFilter)}` : '' }, { replace: true })}>
                Change question types
              </button>
            }
          />
        </div>
      </StudyShell>
    );
  }

  const type = questionType(question);
  const citedChunks = (question.citations ?? [])
    .map((citationId) => material.chunks?.find((chunk) => chunk.id === citationId))
    .filter(Boolean);
  const selectionReady = hasSelection(question, selected);
  const localCorrect = type !== 'short' && answerIsCorrect(question, normaliseSelection(question, selected));
  const typeLabel = TYPE_OPTIONS.find((option) => option.id === type)?.label ?? 'Single-select';
  const hasShortQuestions = questions.some((item) => questionType(item) === 'short');

  return (
    <StudyShell
      title={material.title}
      subtitle={topicFilter ? `Retrying: ${topicFilter}` : matchId ? `Live match · ${questions.length} shared questions` : `${material.quiz?.difficulty ?? 'Conceptual'} · ${questions.length} questions`}
      backTo={`/app/material/${id}`}
      actions={
        <button className="btn btn-ghost btn-sm" onClick={() => setConfirmExit(true)}>
          <Icon name="close" size={17} />
          <span className="action-label">End quiz</span>
        </button>
      }
    >
      <div className="shell quiz">
        {matchId && (
          <div className="match-quiz-banner">
            <Icon name="groups" size={18} />
            <div><strong>Live match</strong><span>Correct answers earn 1,000 points plus a speed bonus. The leaderboard updates every round.</span></div>
          </div>
        )}
        <div className="quiz-progress">
          <ProgressBar value={((index + (checked ? 1 : 0)) / questions.length) * 100} label="Quiz progress" />
          <div className="quiz-meter">
            <span className="num">Question {index + 1} of {questions.length}</span>
            <span className="num">{correctSoFar} correct{scored < questions.length ? ` · ${scored} scored` : ''}</span>
          </div>
        </div>

        <div className="quiz-game-row">
          <span className="game-chip game-chip-timer"><Icon name="timer" size={15} />{timeLeft}s</span>
          <div className="game-timer-track">
            <span style={{ width: `${(Math.max(timeLeft, 0) / TIME_LIMIT_SECONDS) * 100}%` }} />
          </div>
          <span className="game-chip game-chip-streak"><Icon name="local_fire_department" size={15} />{streak}x streak</span>
          <span className="game-chip game-chip-points"><Icon name="military_tech" size={15} />{gamePoints} pts</span>
        </div>

        <article className="quiz-card panel-solid" key={question.id}>
          <div className="quiz-tags">
            <span className="chip">{question.topic}</span>
            <span className="chip">{typeLabel}</span>
            <span className="chip">{['Recall', 'Applied', 'Stretch'][question.difficulty - 1] ?? 'Applied'}</span>
            {!question.verified && (
              <span className="chip chip-warn"><Icon name="info" size={13} />Not scored</span>
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

          {type === 'short' ? (
            <div className="short-answer-field">
              <label htmlFor={`answer-${question.id}`}>Your answer</label>
              <textarea
                id={`answer-${question.id}`}
                value={typeof selected === 'string' ? selected : ''}
                onChange={(event) => !checked && setSelected(event.target.value)}
                disabled={checked}
                maxLength={2000}
                rows={5}
                placeholder="Write a concise answer in your own words…"
              />
              <small>{String(selected ?? '').length} / 2000</small>
            </div>
          ) : (
            <ul className="options" role={type === 'multi' ? 'group' : 'radiogroup'} aria-label="Answer options">
              {question.options.map((option, optionIndex) => {
                const isPicked = type === 'multi' ? selected?.includes?.(optionIndex) : selected === optionIndex;
                const isRight = type === 'multi' ? question.answer.includes(optionIndex) : optionIndex === question.answer;
                const state = !checked ? (isPicked ? 'picked' : 'idle') : isRight ? 'right' : isPicked ? 'wrong' : 'idle';
                return (
                  <li key={optionIndex}>
                    <button
                      type="button"
                      role={type === 'multi' ? 'checkbox' : 'radio'}
                      aria-checked={Boolean(isPicked)}
                      className={`option is-${state}`}
                      onClick={() => selectOption(optionIndex)}
                      disabled={checked}
                    >
                      <span className="option-key num">{LETTERS[optionIndex]}</span>
                      <span className="option-text">{option}</span>
                      {checked && isRight && <Icon name="check_circle" size={20} fill />}
                      {checked && isPicked && !isRight && <Icon name="cancel" size={20} fill />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {checked && type === 'short' && (
            <div className="explain is-recorded">
              <p className="explain-verdict"><Icon name="task_alt" size={18} fill />Answer recorded</p>
              <p>Your short answer will be graded when you submit the quiz. Its verdict, feedback and points will appear on Results.</p>
            </div>
          )}

          {checked && type !== 'short' && (
            <div className={`explain ${localCorrect ? 'is-right' : 'is-wrong'}`}>
              <p className="explain-verdict">
                <Icon name={localCorrect ? 'check_circle' : 'cancel'} size={18} fill />
                {localCorrect ? 'Correct' : type === 'multi' ? 'That is not the exact set' : `The answer is ${LETTERS[question.answer]}`}
              </p>
              <p>{question.explanation}</p>
              {citedChunks.length > 0 && (
                <p className="explain-cites">
                  From{' '}
                  {citedChunks.map((chunk) => (
                    <span key={chunk.id} className="cite">{chunk.label}</span>
                  ))}
                </p>
              )}
            </div>
          )}

          {checked && matchId && (
            <section className="round-leaderboard" aria-live="polite">
              <div className="round-leaderboard-head">
                <div><span>Round {index + 1}</span><strong>Live leaderboard</strong></div>
                {checking && <Spinner size={17} />}
              </div>
              <ol>
                {[...(matchLobby?.players || [])]
                  .sort((left, right) => (right.score || 0) - (left.score || 0))
                  .map((player, rank) => (
                    <li key={player.id}>
                      <span>{rank + 1}</span>
                      <strong>{player.name}</strong>
                      <small>{player.answered || 0} answered · {player.accuracy || 0}%</small>
                      <b>{Number(player.score || 0).toLocaleString()} pts</b>
                    </li>
                  ))}
              </ol>
            </section>
          )}

          <div className="quiz-foot">
            <p className="quiz-hint">
              {checked
                ? 'Press Enter to continue'
                : type === 'short'
                  ? 'Write your answer, then record it'
                  : type === 'multi'
                    ? `Press 1–${Math.min(question.options.length, 9)} to toggle answers, Enter to check`
                    : `Press 1–${Math.min(question.options.length, 9)} to pick, Enter to check`}
            </p>
            {!checked ? (
              <button className="btn btn-primary" onClick={check} disabled={!selectionReady || checking}>
                {checking && <Spinner size={17} />}
                {type === 'short' ? 'Record answer' : 'Check answer'}
              </button>
            ) : (
              <button className="btn btn-primary" onClick={advance} disabled={submitting || checking}>
                {submitting ? <Spinner size={17} /> : null}
                {submitting && hasShortQuestions ? 'Grading answers…' : isLast ? 'See results' : 'Next question'}
                {!isLast && !submitting && <Icon name="arrow_forward" size={18} />}
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
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmExit(false)}>Keep going</button>
            <button className="btn btn-primary btn-sm" onClick={() => navigate(`/app/material/${id}`)}>End without saving</button>
          </>
        }
      >
        <p>You are {index + 1} of {questions.length} questions in. Ending now discards this attempt — it will not appear in your progress or affect your mastery scores.</p>
      </Modal>
    </StudyShell>
  );
}
