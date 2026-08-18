import { useEffect, useMemo, useRef, useState } from 'react';
import { api, apiAssetUrl } from '../lib/api.js';
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
  const endRef = useRef(null);

  const chunkById = new Map((material.chunks ?? []).map((c) => [c.id, c]));

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

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
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

      <div className="ask-thread">
        {thread.length === 0 && suggestions.length > 0 && (
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
                  <img src={apiAssetUrl(m.illustration.path)} alt={`Educational visual for ${m.illustration.topic}`} loading="lazy" />
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
        <div ref={endRef} />
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
