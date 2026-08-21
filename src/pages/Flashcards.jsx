import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.jsx';
import { usePrefs } from '../lib/prefs.jsx';
import { StudyShell } from '../components/layout/Shells.jsx';
import { Icon, Spinner, Empty, ProgressBar, useToast } from '../components/ui.jsx';
import Mascot from '../components/mascot/Mascot.jsx';
import { buildFlashcards, repairFlashcards, review, nextDue, dueCount } from '../lib/srs.js';
import './flashcards.css';

const GRADES = [
  { id: 'again', label: 'Again', hint: 'Back in 10 minutes', icon: 'replay', key: '1' },
  { id: 'good', label: 'Good', hint: 'Normal interval', icon: 'check', key: '2' },
  { id: 'easy', label: 'Easy', hint: 'Longer interval', icon: 'bolt', key: '3' },
];

export default function Flashcards() {
  const { id } = useParams();
  const { materialById } = useStore();
  const { allowMascot } = usePrefs();
  const toast = useToast();

  const material = materialById(id);
  const [cards, setCards] = useState(null);
  const [flipped, setFlipped] = useState(false);
  const [done, setDone] = useState(0);
  const [sessionSize, setSessionSize] = useState(0);

  useEffect(() => {
    if (!material) return;
    let cancelled = false;
    (async () => {
      let saved = null;
      try {
        saved = await api.flashcards.get(id);
      } catch {
        saved = null;
      }
      if (cancelled) return;
      const built = saved?.length ? repairFlashcards(saved, material) : buildFlashcards(material);
      setCards(built);
      setSessionSize(dueCount(built));
    })();
    return () => {
      cancelled = true;
    };
  }, [id, material]);

  const queue = useMemo(() => (cards ? nextDue(cards) : []), [cards]);
  const card = queue[0];

  const grade = useCallback(
    async (g) => {
      if (!card) return;
      const next = cards.map((c) => (c.id === card.id ? { ...c, srs: review(c.srs, g) } : c));
      setCards(next);
      setFlipped(false);
      setDone((d) => d + 1);
      try {
        await api.flashcards.save(id, next);
      } catch {
        toast.error('Could not save your progress on that card.');
      }
    },
    [card, cards, id, toast],
  );

  useEffect(() => {
    const onKey = (e) => {
      if (!card) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setFlipped((f) => !f);
        return;
      }
      if (!flipped) return;
      const g = GRADES.find((x) => x.key === e.key);
      if (g) grade(g.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card, flipped, grade]);

  if (!material) {
    return (
      <StudyShell title="Flashcards">
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

  if (!cards) {
    return (
      <StudyShell title={material.title} backTo={`/app/material/${id}`}>
        <div className="shell fc-loading" role="status">
          <Spinner size={22} />
          <span>Building your deck…</span>
        </div>
      </StudyShell>
    );
  }

  const labels = (card?.citations ?? [])
    .map((c) => material.chunks?.find((x) => x.id === c)?.label)
    .filter(Boolean);

  return (
    <StudyShell
      title={material.title}
      subtitle={`${cards.length} cards · ${queue.length} due now`}
      backTo={`/app/material/${id}`}
    >
      <div className="shell flashcards">
        {!card ? (
          <div className="fc-done panel-solid">
            {allowMascot && <Mascot state="celebrate" size={200} shadow={false} />}
            <h2>Nothing due right now</h2>
            <p>
              {done > 0
                ? `You reviewed ${done} ${done === 1 ? 'card' : 'cards'}. The next ones come back on their own schedule — that spacing is what moves them into long-term memory.`
                : 'Nothing in this deck is due yet. Come back when it is, or take the quiz to find weak spots now.'}
            </p>
            <div className="row wrap gap-2 center">
              <Link to={`/app/material/${id}/quiz`} className="btn btn-primary">
                <Icon name="quiz" size={18} />
                Take the quiz
              </Link>
              <Link to={`/app/material/${id}`} className="btn btn-ghost">
                Back to the recap
              </Link>
            </div>
            <ul className="fc-schedule">
              {[...cards]
                .sort((a, b) => a.srs.dueAt - b.srs.dueAt)
                .slice(0, 5)
                .map((c) => (
                  <li key={c.id}>
                    <span className="truncate">{c.front}</span>
                    <span className="num">
                      {new Date(c.srs.dueAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        ) : (
          <>
            <div className="fc-progress">
              <ProgressBar
                value={sessionSize ? (done / sessionSize) * 100 : 0}
                label="Cards reviewed this session"
              />
              <div className="fc-meter">
                <span className="num">
                  {done} of {sessionSize} reviewed
                </span>
                <span className="num">{queue.length} left</span>
              </div>
            </div>

            <button
              type="button"
              className={`fc-card ${flipped ? 'is-flipped' : ''}`}
              onClick={() => setFlipped((f) => !f)}
              aria-live="polite"
              aria-label={flipped ? 'Answer shown. Press space to flip back.' : 'Question shown. Press space to reveal.'}
            >
              <div className="fc-inner">
                <div className="fc-face fc-front">
                  <span className="chip fc-topic">{card.topic}</span>
                  <p>{card.front}</p>
                  <span className="fc-flip-hint">
                    <Icon name="autorenew" size={15} />
                    Click, or press space
                  </span>
                </div>
                <div className="fc-face fc-back">
                  <span className="chip fc-topic">{card.topic}</span>
                  <p>{card.back}</p>
                  {labels.length > 0 && (
                    <span className="fc-cites">
                      {labels.map((l) => (
                        <span key={l} className="cite">
                          {l}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            </button>

            <div className={`fc-grades ${flipped ? 'is-on' : ''}`} aria-hidden={!flipped}>
              {GRADES.map((g) => (
                <button
                  key={g.id}
                  className={`fc-grade is-${g.id}`}
                  onClick={() => grade(g.id)}
                  disabled={!flipped}
                  tabIndex={flipped ? 0 : -1}
                >
                  <Icon name={g.icon} size={19} />
                  <strong>{g.label}</strong>
                  <span>{g.hint}</span>
                  <kbd>{g.key}</kbd>
                </button>
              ))}
            </div>

            <p className="fc-note">
              Cards you get right come back less and less often. Ones you miss come back sooner, and again later
              today. Spacing them out like this is what moves them into long-term memory.
            </p>
          </>
        )}
      </div>
    </StudyShell>
  );
}
