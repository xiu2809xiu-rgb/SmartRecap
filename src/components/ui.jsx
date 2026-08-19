import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Material Symbols wrapper. A real icon set — never a unicode glyph stand-in. */
export const Icon = ({ name, className = '', fill = false, size, ...rest }) => (
  <span
    className={`material-symbols-rounded ${className}`}
    style={{
      ...(size ? { fontSize: size } : null),
      ...(fill ? { fontVariationSettings: "'FILL' 1, 'wght' 500, 'GRAD' 0, 'opsz' 24" } : null),
    }}
    aria-hidden="true"
    {...rest}
  >
    {name}
  </span>
);

export function Spinner({ size = 18, label = 'Loading' }) {
  return (
    <span className="spinner" style={{ width: size, height: size }} role="status" aria-label={label}>
      <svg viewBox="0 0 24 24" width={size} height={size}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
        <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function Empty({ icon = 'inbox', title, body, action }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={28} />
      </span>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

export function ProgressBar({ value, label }) {
  return (
    <div
      className="progressbar"
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Toasts
   ------------------------------------------------------------------------ */

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const seq = useRef(0);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const push = useCallback(
    (message, { tone = 'info', duration = 4200, action } = {}) => {
      const id = ++seq.current;
      setToasts((t) => [...t, { id, message, tone, action }]);
      if (duration) setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss],
  );

  const value = useMemo(
    () => ({
      push,
      dismiss,
      success: (m, o) => push(m, { ...o, tone: 'success' }),
      error: (m, o) => push(m, { ...o, tone: 'error', duration: 6500 }),
      info: push,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="toast-stack" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.tone}`}>
              <Icon
                name={t.tone === 'success' ? 'check_circle' : t.tone === 'error' ? 'error' : 'info'}
                size={18}
              />
              <span className="grow">{t.message}</span>
              {t.action}
              <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
                <Icon name="close" size={16} />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

/* ---------------------------------------------------------------------------
   Modal
   ------------------------------------------------------------------------ */

export function Modal({ open, onClose, title, children, footer, width = 520 }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    const previouslyFocused = document.activeElement;
    ref.current?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div
        className="modal panel-solid"
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close dialog">
            <Icon name="close" size={20} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------------------------------------------------------------------
   Segmented control — used for quiz filters and recap depth
   ------------------------------------------------------------------------ */

export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? 'is-on' : ''}
          onClick={() => onChange(o.value)}
          type="button"
        >
          {o.icon && <Icon name={o.icon} size={17} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Copy-to-clipboard button that reports what happened. */
export function CopyButton({ value, children = 'Copy', className = 'btn btn-ghost btn-sm' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        } catch {
          setDone(false);
        }
      }}
    >
      <Icon name={done ? 'check' : 'content_copy'} size={16} />
      {done ? 'Copied' : children}
    </button>
  );
}

/* ---------------------------------------------------------------------------
   Accessible custom select / listbox
   ------------------------------------------------------------------------ */

export function Select({
  options = [],
  value,
  onChange,
  label,
  placeholder = 'Choose an option',
  disabled = false,
  emptyText = 'No options available',
  className = '',
}) {
  const id = useId();
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const listRef = useRef(null);
  const [open, setOpen] = useState(false);
  const enabled = options.filter((option) => !option.disabled);
  const selected = options.find((option) => String(option.value) === String(value));
  const [activeValue, setActiveValue] = useState(selected?.value ?? enabled[0]?.value);
  const activeIndex = options.findIndex((option) => String(option.value) === String(activeValue));
  const activeOptionId = activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined;
  const unavailable = disabled || enabled.length === 0;

  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActiveValue(selected?.value ?? enabled[0]?.value);
    listRef.current?.focus();
  }, [open, selected?.value]);

  const move = (direction) => {
    if (!enabled.length) return;
    const current = enabled.findIndex((option) => String(option.value) === String(activeValue));
    const next = current < 0 ? 0 : (current + direction + enabled.length) % enabled.length;
    setActiveValue(enabled[next].value);
  };

  const choose = (option) => {
    if (!option || option.disabled) return;
    onChange?.(option.value, option);
    setActiveValue(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onKeyDown = (event) => {
    if (unavailable) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) setOpen(true);
      else move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setOpen(true);
      setActiveValue(enabled[event.key === 'Home' ? 0 : enabled.length - 1]?.value);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) setOpen(true);
      else choose(enabled.find((option) => String(option.value) === String(activeValue)));
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    }
  };

  return (
    <div className={`custom-select ${open ? 'is-open' : ''} ${className}`} ref={rootRef}>
      <button
        id={`${id}-button`}
        ref={buttonRef}
        type="button"
        className="custom-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        aria-label={label}
        disabled={unavailable}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
      >
        <span className="custom-select-copy">
          <strong title={selected?.label}>{selected?.label ?? (options.length ? placeholder : emptyText)}</strong>
          {selected?.secondary && <small title={selected.secondary}>{selected.secondary}</small>}
        </span>
        <Icon name="expand_more" size={20} />
      </button>
      {open && (
        <ul
          id={`${id}-listbox`}
          ref={listRef}
          className="custom-select-list"
          role="listbox"
          aria-labelledby={`${id}-button`}
          aria-activedescendant={activeOptionId}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          {options.length ? options.map((option, optionIndex) => {
            const chosen = String(option.value) === String(value);
            const active = String(option.value) === String(activeValue);
            return (
              <li
                id={`${id}-option-${optionIndex}`}
                key={`${String(option.value)}-${optionIndex}`}
                role="option"
                aria-selected={chosen}
                aria-disabled={option.disabled || undefined}
                className={`${chosen ? 'is-selected' : ''} ${active ? 'is-active' : ''} ${option.disabled ? 'is-disabled' : ''}`}
                onPointerMove={() => !option.disabled && setActiveValue(option.value)}
                onClick={() => choose(option)}
              >
                {option.icon && <Icon name={option.icon} size={19} />}
                <span><strong title={option.label}>{option.label}</strong>{option.secondary && <small title={option.secondary}>{option.secondary}</small>}</span>
                {chosen && <Icon name="check" size={18} />}
              </li>
            );
          }) : <li className="custom-select-empty" aria-disabled="true">{emptyText}</li>}
        </ul>
      )}
    </div>
  );
}