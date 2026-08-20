import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import AuthImage from './AuthImage.jsx';
import { Icon, Spinner } from './ui.jsx';
import SafeMarkdown from './SafeMarkdown.jsx';

/**
 * "Ask this material" — grounded Q&A.
 *
 * The rule is the same as the recap's: an answer either quotes the uploaded
 * material and shows which slide it came from, or it says the material does not
 * cover it. There is no third mode where the model answers from general
 * knowledge and lets you assume it came from your lecture.
 */
export default function AskPanel({ material, open, onClose }) {
  const [question, setQuestion] = useState('');
  const [thread, setThread] = useState([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const threadRef = useRef(null);

  const chunkById = useMemo(
    () => new Map((material.chunks ?? []).map((c) => [c.id, c])),
    [material],
  );

  /**
   * Prompts drawn from this material's own key terms and section headings.
   * Hardcoded examples would suggest database questions to someone who just
   * uploaded a chemistry deck — worse than showing nothing, because it implies
   * the panel has not read their file.
   */
  const suggestions = useMemo(() => {
    const terms = (material.recap?.keyTerms ?? []).slice(0, 2).map((t) => `What does "${t.term}" mean?`);
    const headings = (material.recap?.sections ?? [])
      .slice(0, 2)
      .map((s) => `Explain ${s.heading.charAt(0).toLowerCase()}${s.heading.slice(1)}.`);
    return [...terms, ...headings].slice(0, 3);
  }, [material]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /**
   * Scroll the thread itself rather than calling scrollIntoView on a trailing
   * node. scrollIntoView walks up and scrolls every scrollable ancestor, and
   * this panel is fixed over a long page — so it yanked the page behind the
   * panel on open and after every answer.
   */
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread, busy]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const ask = async (e) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setThread((t) => [...t, { role: 'user', text: q }]);
    setQuestion('');
    setBusy(true);
    try {
      const res = await api.ask({ materialId: material.id, question: q });
      setThread((t) => [...t, { role: 'assistant', ...res }]);
    } catch (err) {
      setThread((t) => [...t, { role: 'assistant', answer: err.message ?? 'That request failed.', citations: [], error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const createVisual = async (index, answerId) => {
    setThread((items) => items.map((item, itemIndex) => (
      itemIndex === index ? { ...item, visualBusy: true, visualError: null } : item
    )));
    try {
      const illustration = await api.illustrations.createFromChat(material.id, answerId);
      setThread((items) => items.map((item, itemIndex) => (
        itemIndex === index ? { ...item, illustration, visualBusy: false } : item
      )));
    } catch (error) {
      setThread((items) => items.map((item, itemIndex) => (
        itemIndex === index
          ? { ...item, visualBusy: false, visualError: error.message ?? 'Could not create a visual for this answer.' }
          : item
      )));
    }
  };

  if (!open) return null;

  return (
    <aside className="ask-panel" role="complementary" aria-label="Ask this material">
      <header className="ask-head">
        <div>
          <h2>Ask this material</h2>
          <p>Answers quote your slides, or say the deck does not cover it.</p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close the question panel">
          <Icon name="close" size={20} />
        </button>
      </header>

      <div className="ask-thread" ref={threadRef} aria-live="polite">
        {thread.length === 0 && (
          <div className="ask-empty">
            <Icon name="forum" size={26} />
            <p className="ask-empty-title">Ask anything about this material</p>
            <p className="ask-empty-body">
              Every answer quotes the slide it came from. If your deck does not cover
              something, the answer says so instead of guessing.
            </p>
            {/* Suggestions need a recap to draw real terms from. A deck still being
                processed has none, and the panel used to render nothing at all. */}
            {suggestions.length > 0 && (
              <div className="ask-hint">
                <p>Try one of these:</p>
                <ul>
                  {suggestions.map((s) => (
                    <li key={s}>
                      <button type="button" onClick={() => setQuestion(s)}>
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {thread.map((m, i) =>
          m.role === 'user' ? (
            <p key={i} className="ask-q">
              {m.text}
            </p>
          ) : (
            <div key={i} className={`ask-a ${m.error ? 'is-error' : ''} ${m.grounded === false ? 'is-ungrounded' : ''}`}>
              <SafeMarkdown className="ask-answer-markdown">{m.answer}</SafeMarkdown>
              {m.citations?.length > 0 && (
                <p className="ask-cites">
                  {m.citations.map((c) => (
                    <a key={c} href={`#src-${c}`} className="cite">
                      {chunkById.get(c)?.label ?? c}
                    </a>
                  ))}
                </p>
              )}
              {m.answerId && !m.error && !m.illustration && (
                <button
                  className="ask-visual-button"
                  type="button"
                  onClick={() => createVisual(i, m.answerId)}
                  disabled={m.visualBusy}
                >
                  {m.visualBusy ? <Spinner size={14} /> : <Icon name="image" size={15} />}
                  {m.visualBusy ? 'Creating source-grounded visual…' : 'Generate visual from this answer'}
                </button>
              )}
              {m.illustration && (
                <figure className="ask-visual">
                  <AuthImage path={m.illustration.path} alt={`Educational visual for ${m.illustration.topic}`} />
                  <figcaption>{m.illustration.provider} · {m.illustration.model}</figcaption>
                </figure>
              )}
              {m.visualError && <p className="ask-visual-error">{m.visualError}</p>}
              {m.grounded === false && !m.error && (
                <p className="ask-flag">
                  <Icon name="info" size={14} />
                  Not covered by this material
                </p>
              )}
            </div>
          ),
        )}

        {busy && (
          <div className="ask-a is-busy">
            <Spinner size={16} />
            <span>Searching your material…</span>
          </div>
        )}
      </div>

      <form className="ask-form" onSubmit={ask}>
        <input
          ref={inputRef}
          className="input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about anything in this deck"
          aria-label="Your question"
        />
        <button className="btn btn-primary btn-sm" disabled={busy || !question.trim()}>
          <Icon name="send" size={17} />
          <span className="sr-only">Send</span>
        </button>
      </form>
    </aside>
  );
}
