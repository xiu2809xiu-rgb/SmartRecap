import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { usePrefs } from '../lib/prefs.jsx';
import { StudyShell } from '../components/layout/Shells.jsx';
import { Icon, Spinner, Empty, ProgressBar, useToast } from '../components/ui.jsx';
import Mascot from '../mascot/Mascot.jsx';
import { buildFlashcards, repairFlashcards, review, nextDue, dueCount } from '../lib/srs.js';
import './flashcards.css';

const GRADES = [
  { id: 'again', label: 'Again', hint: 'Back in 10 minutes', icon: 'replay', key: '1' },
  { id: 'good', label: 'Good', hint: 'Normal interval', icon: 'check', key: '2' },
  { id: 'easy', label: 'Easy', hint: 'Longer interval', icon: 'bolt', key: '3' },
];

/**
 * Flashcards over a whole Binder's recap, mirroring `Flashcards.jsx` for a
 * single Material — `buildFlashcards` only reads `recap.keyTerms` and
 * `quiz.questions`, which a Binder carries in the same shape, so it reuses
 * the same deck builder and SRS scheduling rather than a second implementation.
 */
export default function BinderFlashcards() {
  const { id } = useParams();
  const { allowMascot } = usePrefs();
  const toast = useToast();

  const [binder, setBinder] = useState(null);
  const [error, setError] = useState(null);
  const [cards, setCards] = useState(null);
  const [flipped, setFlipped] = useState(false);
  const [done, setDone] = useState(0);
  const [sessionSize, setSessionSize] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const full = await api.binders.get(id);
        if (!cancelled) setBinder(full);
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!binder?.recap) return;
    let cancelled = false;
    (async () => {
      let saved = null;
      try {
        saved = await api.binders.flashcards.get(id);
      } catch {
        saved = null;
      }
      if (cancelled) return;
      const built = saved?.length ? repairFlashcards(saved, binder) : buildFlashcards(binder);
      setCards(built);
      setSessionSize(dueCount(built));
    })();
    return () => {
      cancelled = true;
    };
  }, [id, binder]);

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
        await api.binders.flashcards.save(id, next);
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

  if (error) {
    return (
      <StudyShell title="Flashcards unavailable" backTo="/app/binders">
        <div className="shell">
          <Empty
            icon="error"
            title="That binder is not in your library"
            action={
              <Link to="/app/binders" className="btn btn-primary">
                Back to binders
              </Link>
            }
          />
        </div>
      </StudyShell>
    );
  }

  if (!binder) {
    return (
      <StudyShell title="Loading flashcards" backTo="/app/binders">
        <div className="shell fc-loading" role="status">
          <Spinner size={22} />
          <span>Opening your deck…</span>
        </div>
      </StudyShell>
    );
  }

  if (!binder.recap) {
    return (
      <StudyShell title={binder.name} backTo={`/app/binders/${id}`}>
        <div className="shell">
          <Empty
            icon="auto_awesome"
            title="Nothing generated yet"
            body="Go back to this binder and click Generate recap once at least one source is ready."
            action={
              <Link to={`/app/binders/${id}`} className="btn btn-primary">
                Open binder
              </Link>
            }
          />
        </div>
      </StudyShell>
    );
  }

  if (!cards) {
    return (
      <StudyShell title={binder.name} backTo={`/app/binders/${id}/recap`}>
        <div className="shell fc-loading" role="status">
          <Spinner size={22} />
          <span>Building your deck…</span>
        </div>
      </StudyShell>
    );
  }

  const labels = (card?.citations ?? [])
    .map((c) => binder.chunks?.find((x) => x.id === c)?.label)
    .filter(Boolean);

  return (
    <StudyShell
      title={binder.name}
      subtitle={`${cards.length} cards · ${queue.length} due now`}
      backTo={`/app/binders/${id}/recap`}
    >
      <div className="shell flashcards">
        {!card ? (
          <div className="fc-done panel-solid">
            {allowMascot && <Mascot state="celebrate" size={200} shadow={false} />}
            <h2>Nothing due right now</h2>
            <p>
              {done > 0
                ? `You reviewed ${done} ${done === 1 ? 'card' : 'cards'}. The next ones come back on their own schedule — that spacing is what moves them into long-term memory.`
                : 'Nothing in this deck is due yet. Come back when it is, or read the recap again to find weak spots now.'}
            </p>
            <div className="row wrap gap-2 center">
              <Link to={`/app/binders/${id}/recap`} className="btn btn-primary">
                <Icon name="auto_awesome" size={18} />
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
