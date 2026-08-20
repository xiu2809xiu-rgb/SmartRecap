import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { Icon, Spinner } from '../components/ui.jsx';
import SafeMarkdown from '../components/SafeMarkdown.jsx';
import { usePrefs } from '../lib/prefs.jsx';

/**
 * The pair-programmer docked beside the practice editor.
 *
 * It reads whatever is in the editor on every turn, so "why is this wrong"
 * needs no copy-paste — the question a student actually types is short and
 * about their own code, which is the whole point of putting it here instead of
 * sending them to a separate chat.
 *
 * Two things it deliberately does not do:
 *
 * - It holds no API key. The request goes to our backend, which talks to NVIDIA
 *   with a server-side key. A provider key in this file would ship inside the
 *   bundle and be readable by anyone who opens devtools.
 * - It does not hand over solutions on a graded exercise. `allowSolutions` is
 *   true only in the Playground; the backend re-applies the same rule rather
 *   than trusting this flag, because a client can send anything.
 */

const QUICK_ACTIONS = [
  { icon: 'menu_book', label: 'Explain this', prompt: 'Walk me through what this code does, step by step.' },
  { icon: 'bug_report', label: 'Find the bug', prompt: 'Something is wrong here. Find the bug and tell me exactly what to change.' },
  { icon: 'auto_fix_high', label: 'Make it cleaner', prompt: 'How would you simplify this without changing what it does?' },
  { icon: 'comment', label: 'Add comments', prompt: 'Add clear comments to this code explaining the parts that are not obvious.' },
];

export default function CodeAgent({ open, onClose, language, code, brief, output, allowSolutions, onApply }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const threadRef = useRef(null);
  const inputRef = useRef(null);
  const { reduced } = usePrefs();

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Scroll the thread itself. scrollIntoView would also scroll every scrollable
  // ancestor, and this panel sits inside the practice grid.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const send = useCallback(async (text) => {
    const question = text.trim();
    if (!question || busy) return;

    const history = [...messages, { role: 'user', content: question }];
    setMessages(history);
    setInput('');
    setBusy(true);
    try {
      const res = await api.practice.agent({
        language,
        code,
        brief: brief ?? '',
        output: output ?? '',
        allowSolutions: Boolean(allowSolutions),
        messages: history.map((m) => ({ role: m.role, content: m.content })),
      });
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: res.reply,
        model: res.model,
        suggestion: res.suggestion ?? null,
      }]);
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: err.message ?? 'The coding agent could not be reached.',
        error: true,
      }]);
    } finally {
      setBusy(false);
    }
  }, [allowSolutions, brief, busy, code, language, messages, output]);

  if (!open) return null;

  return (
    <aside className={`agent-panel ${reduced ? 'is-still' : ''}`} aria-label="Coding agent">
      <header className="agent-head">
        <span className="agent-mark" aria-hidden="true">
          <Icon name="smart_toy" size={17} />
        </span>
        <div className="agent-head-text">
          <h2>Coding agent</h2>
          <p>{allowSolutions ? 'Reads your editor as you go' : 'Guides you — no solutions on a graded exercise'}</p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close the coding agent">
          <Icon name="close" size={18} />
        </button>
      </header>

      <div className="agent-thread" ref={threadRef} aria-live="polite">
        {messages.length === 0 && (
          <div className="agent-empty">
            <p className="agent-empty-title">Ask about the code in your editor</p>
            <p className="agent-empty-body">
              It always sees your current file{brief ? ' and the exercise you are on' : ''}, so you can just ask
              &ldquo;why is this wrong?&rdquo; without pasting anything.
            </p>
            <div className="agent-actions">
              {QUICK_ACTIONS.map((action, i) => (
                <button
                  key={action.label}
                  type="button"
                  className="agent-action"
                  style={{ '--i': i }}
                  onClick={() => send(action.prompt)}
                >
                  <Icon name={action.icon} size={15} />
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          m.role === 'user' ? (
            <p key={i} className="agent-q">{m.content}</p>
          ) : (
            <div key={i} className={`agent-a ${m.error ? 'is-error' : ''}`}>
              <SafeMarkdown className="agent-markdown">{m.content}</SafeMarkdown>
              {m.suggestion && (
                <button
                  type="button"
                  className={`agent-apply ${m.applied ? 'is-applied' : ''}`}
                  onClick={() => {
                    onApply(m.suggestion);
                    setMessages((prev) => prev.map((item, index) => (
                      index === i ? { ...item, applied: true } : item
                    )));
                  }}
                >
                  <Icon name={m.applied ? 'check' : 'download'} size={15} />
                  {m.applied ? 'Applied to editor' : 'Apply to editor'}
                </button>
              )}
              {m.model && !m.error && <p className="agent-model">{m.model}</p>}
            </div>
          )
        ))}

        {busy && (
          <div className="agent-a is-thinking" role="status">
            <span className="agent-dots" aria-hidden="true"><i /><i /><i /></span>
            <span className="agent-thinking-text">Reading your editor…</span>
          </div>
        )}
      </div>

      <form
        className="agent-form"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          ref={inputRef}
          className="input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your code…"
          aria-label="Ask the coding agent"
        />
        <button className="btn btn-primary btn-sm" disabled={busy || !input.trim()}>
          {busy ? <Spinner size={15} /> : <Icon name="send" size={16} />}
          <span className="sr-only">Send</span>
        </button>
      </form>
    </aside>
  );
}
