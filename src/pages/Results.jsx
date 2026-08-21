import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.jsx';
import { useJobs } from '../components/jobs.jsx';
import { enableCompletionNotifications } from '../lib/notifications.js';
import { usePrefs } from '../lib/prefs.jsx';
import { StudyShell } from '../components/layout/Shells.jsx';
import { Icon, Spinner, Empty, useToast } from '../components/ui.jsx';
import { MatchAvatar } from '../components/MatchAvatar.jsx';
import { ScoreRing, MasteryBars } from '../components/charts/Charts.jsx';
import Mascot from '../components/mascot/Mascot.jsx';
import CountUp from '../reactbits/CountUp.jsx';
import { formatDuration } from '../lib/format.js';
import { questionType, exactSetMatch } from '../lib/quizScoring.js';
import './results.css';

function optionText(question, indices) {
  const values = Array.isArray(indices) ? indices : [];
  if (!values.length) return 'No answer';
  return values.map((index) => question.options?.[index]).filter(Boolean).join('; ') || 'No answer';
}

export default function Results() {
  const { id, attemptId } = useParams();
  const [params] = useSearchParams();
  const matchId = params.get('match');
  const { materialById, attemptsFor } = useStore();
  const { registerJob } = useJobs();
  const toast = useToast();
  const { allowMascot } = usePrefs();
  const location = useLocation();
  const gameStats = location.state?.gamePoints != null ? location.state : null;

  const material = materialById(id);
  const attempts = attemptsFor(id);
  const attempt = attempts.find((a) => a.id === attemptId) ?? attempts[0];

  const [fallback, setFallback] = useState(null);
  const [matchLobby, setMatchLobby] = useState(null);
  const [generatingWeak, setGeneratingWeak] = useState(false);
  useEffect(() => {
    if (attempt || fallback) return;
    api.quiz
      .attempts(id)
      .then((list) => setFallback(list.find((a) => a.id === attemptId) ?? list[0] ?? null))
      .catch(() => setFallback(null));
  }, [attempt, fallback, id, attemptId]);

  useEffect(() => {
    if (!matchId) return undefined;
    const refresh = () => api.lobbies.get(matchId).then(setMatchLobby).catch(() => {});
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [matchId]);

  const shown = attempt ?? fallback;

  const weakTopics = useMemo(
    () => (shown?.byTopic ?? []).filter((t) => t.total > 0 && t.correct / t.total < 0.7),
    [shown],
  );

  const generateWeakQuiz = async () => {
    if (!shown || !weakTopics.length || generatingWeak) return;
    setGeneratingWeak(true);
    void enableCompletionNotifications();
    try {
      const requested = Math.max(5, Math.min(15, weakTopics.length * 5));
      const questionCount = requested <= 5 ? 5 : requested <= 10 ? 10 : 15;
      const difficulty = ['easy', 'medium', 'hard'].includes(shown.difficulty) ? shown.difficulty : 'medium';
      const sourceQuestions = shown.questions ?? material?.quiz?.questions ?? [];
      const questionTypes = [...new Set(sourceQuestions.map(questionType))];
      const response = await api.quiz.generate(id, {
        difficulty,
        questionCount,
        questionTypes: questionTypes.length ? questionTypes : ['single'],
        topics: weakTopics.map((topic) => topic.topic),
        fresh: true,
      });
      registerJob({
        id: response.jobId,
        materialId: id,
        kind: 'quiz',
        title: material.title,
        stage: 'queued',
        stageLabel: `Creating new questions for ${weakTopics.map((topic) => topic.topic).join(', ')}`,
        progress: 0,
      });
      toast.info('A fresh weak-area quiz is being created. None of the previous question prompts will be reused.');
    } catch (error) {
      toast.error(error.message || 'Could not create a new weak-area quiz.');
    } finally {
      setGeneratingWeak(false);
    }
  };

  const previous = useMemo(() => {
    if (!shown) return null;
    const older = attempts.filter((a) => new Date(a.at) < new Date(shown.at));
    return older.length ? older[0] : null;
  }, [attempts, shown]);

  if (!material) {
    return (
      <StudyShell title="Results">
        <div className="shell">
          <Empty
            icon="error"
            title="That material is not in your library"
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

  if (!shown) {
    return (
      <StudyShell title={material.title} backTo={`/app/material/${id}`}>
        <div className="shell results-loading" role="status">
          <Spinner size={22} />
          <span>Loading your attempt…</span>
        </div>
      </StudyShell>
    );
  }

  const tone = shown.score >= 80 ? 'good' : shown.score >= 50 ? 'warn' : 'bad';
  const delta = previous ? shown.score - previous.score : null;

  const headline =
    shown.score >= 80
      ? 'You know this deck.'
      : shown.score >= 50
        ? 'Most of it landed.'
        : 'Worth another pass before the exam.';

  const advice =
    weakTopics.length === 0
      ? 'Nothing came out under 70%. Come back in a few days and the flashcards will be due — that is what makes it stick.'
      : `${weakTopics.map((t) => t.topic).join(', ')} ${weakTopics.length === 1 ? 'is' : 'are'} under 70%. Retrying just those takes about two minutes.`;

  const topicRows = shown.byTopic.map((t) => ({
    topic: t.topic,
    correct: t.correct,
    total: t.total,
    mastery: Math.round((t.correct / t.total) * 100),
  }));

  return (
    <StudyShell
      title={material.title}
      subtitle={`Attempt ${attempts.length - attempts.indexOf(shown)} of ${attempts.length}`}
      backTo={`/app/material/${id}`}
      actions={
        <Link to={`/app/material/${id}/flashcards`} className="btn btn-ghost btn-sm">
          <Icon name="style" size={17} />
          <span className="action-label">Flashcards</span>
        </Link>
      }
    >
      <div className="shell results">
        <section className={`results-hero panel-solid tone-${tone}`}>
          <div className="results-score">
            <ScoreRing score={shown.score} size={190} label={`${shown.correct} of ${shown.total}`} />
          </div>

          <div className="results-copy">
            <h1>{headline}</h1>
            <p className="lede">{advice}</p>

            <dl className="results-meta">
              <div>
                <dt>Correct</dt>
                <dd className="num">
                  <CountUp to={shown.correct} duration={1} /> / {shown.total}
                </dd>
              </div>
              <div>
                <dt>Time taken</dt>
                <dd className="num">{formatDuration(shown.durationMs ?? 0)}</dd>
              </div>
              <div>
                <dt>Change</dt>
                <dd className={`num ${delta == null ? '' : delta >= 0 ? 'is-up' : 'is-down'}`}>
                  {delta == null ? 'First attempt' : `${delta >= 0 ? '+' : ''}${delta} pts`}
                </dd>
              </div>
            </dl>

            {gameStats && (
              <div className="results-game-stats">
                <span className="game-chip game-chip-points">
                  <Icon name="military_tech" size={16} />
                  {gameStats.gamePoints} pts
                </span>
                <span className="game-chip game-chip-streak">
                  <Icon name="local_fire_department" size={16} />
                  Best streak {gameStats.bestStreak}x
                </span>
              </div>
            )}

            <div className="row wrap gap-2 results-actions">
              {weakTopics.length > 0 && (
                <>
                  <button className="btn btn-primary" type="button" onClick={generateWeakQuiz} disabled={generatingWeak}>
                    {generatingWeak ? <Spinner size={17} /> : <Icon name="auto_awesome" size={18} />}
                    Generate new weak-area questions
                  </button>
                  <Link
                    to={`/app/material/${id}/quiz?topics=${encodeURIComponent(weakTopics.map((t) => t.topic).join(','))}`}
                    className="btn btn-ghost"
                  >
                    <Icon name="replay" size={18} />
                    Retry current weak questions
                  </Link>
                </>
              )}
              <Link to={`/app/material/${id}/quiz`} className="btn btn-ghost">
                <Icon name="replay" size={18} />
                Full quiz again
              </Link>
              <Link to={`/app/material/${id}`} className="btn btn-ghost">
                <Icon name="menu_book" size={18} />
                Back to the recap
              </Link>
            </div>
          </div>

          {allowMascot && (
            <div className="results-mascot">
              <Mascot state={shown.score >= 80 ? 'celebrate' : 'encourage'} size={200} shadow={false} caption />
            </div>
          )}
        </section>

        {matchId && (
          <section className="results-match panel">
            <div className="results-match-head">
              <div><p className="eyebrow">Multiplayer match</p><h2>{matchLobby?.status === 'finished' ? 'Final leaderboard' : 'Waiting for everyone to finish'}</h2></div>
              <Link className="btn btn-ghost btn-sm" to={`/app/material/${id}/match/${matchId}`}><Icon name="groups" size={17} />Open room</Link>
            </div>
            <ol className="results-leaderboard">
              {[...(matchLobby?.players || [])].sort((a, b) => (b.score || 0) - (a.score || 0)).map((player, index) => (
                <li key={player.id}><span>{index + 1}</span><MatchAvatar avatarId={player.avatarId ?? player.avatar_id} size="sm" label={`${player.name}'s avatar`} /><strong>{player.name}</strong><small>{player.submitted ? `${player.accuracy ?? 0}% accuracy` : `${player.answered || 0} answered`}</small><b>{player.submitted ? `${Number(player.score || 0).toLocaleString()} pts` : '—'}</b></li>
              ))}
            </ol>
          </section>
        )}

        <section className="results-topics panel">
          <h2>Where the marks went</h2>
          <MasteryBars topics={topicRows} />
        </section>

        <section className="results-review panel">
          <h2>Every question, with the source</h2>
          <ul className="review-list">
            {(shown.questions ?? material.quiz?.questions ?? [])
              .filter((q) => q.id in (shown.answers ?? {}))
              .map((q) => {
                const picked = shown.answers[q.id];
                const type = questionType(q);
                const judgement = shown.judgements?.[q.id];
                const right =
                  type === 'short'
                    ? judgement?.correct === true
                    : type === 'multi'
                      ? exactSetMatch(picked, q.answer)
                      : picked === q.answer;
                const unscored = !q.verified || (type === 'short' && judgement?.verified !== true);
                const neutral = type === 'short' && judgement?.correct == null;
                const labels = (q.citations ?? [])
                  .map((c) => material.chunks?.find((x) => x.id === c)?.label)
                  .filter(Boolean);

                let answerReview;
                if (type === 'short') {
                  answerReview = (
                    <>
                      <p className="review-answer"><strong>{neutral ? 'Not scored' : right ? 'Correct' : 'Incorrect'}.</strong> Your answer: <em>{picked || 'No answer'}</em></p>
                      <p className="review-answer">Model answer: <strong>{q.modelAnswer}</strong></p>
                      <p className="review-explain">
                        {judgement?.feedback ?? (q.verified ? 'No judgement was returned, so this answer was not scored.' : q.explanation)}
                      </p>
                    </>
                  );
                } else if (type === 'multi') {
                  answerReview = (
                    <>
                      <p className="review-answer">Your answers: <em>{optionText(q, picked)}</em></p>
                      {!right && <p className="review-answer">Correct answers: <strong>{optionText(q, q.answer)}</strong></p>}
                      <p className="review-explain">{q.explanation}</p>
                    </>
                  );
                } else {
                  answerReview = (
                    <>
                      <p className="review-answer">
                        {right ? (
                          <>Your answer: {q.options?.[picked] ?? 'No answer'}</>
                        ) : (
                          <>You chose <em>{q.options?.[picked] ?? 'No answer'}</em>. The answer is <strong>{q.options?.[q.answer]}</strong>.</>
                        )}
                      </p>
                      <p className="review-explain">{q.explanation}</p>
                    </>
                  );
                }

                return (
                  <li key={q.id} className={`review ${neutral ? 'is-unscored' : right ? 'is-right' : 'is-wrong'} ${unscored ? 'is-unscored' : ''}`}>
                    <span className="review-mark">
                      <Icon name={neutral ? 'info' : right ? 'check' : 'close'} size={16} />
                    </span>
                    <div>
                      <p className="review-prompt">{q.prompt}</p>
                      {answerReview}
                      <p className="review-tags">
                        <span className="chip">{q.topic}</span>
                        <span className="chip">{type === 'single' ? 'Single-select' : type === 'multi' ? 'Multi-select' : 'Short answer'}</span>
                        {labels.map((l) => (
                          <span key={l} className="cite">{l}</span>
                        ))}
                        {judgement?.gradedBy && <span className="chip">Graded by {judgement.gradedBy}</span>}
                        {unscored && <span className="chip chip-warn">Not scored</span>}
                      </p>
                    </div>
                  </li>
                );
              })}
          </ul>
        </section>
      </div>
    </StudyShell>
  );
}
