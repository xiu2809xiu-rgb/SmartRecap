import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { NavLink } from 'react-router-dom';
import { Icon } from '../ui.jsx';
import './mobile-nav.css';

/**
 * The navigation drawer for narrow screens.
 *
 * Replaces a bottom tab bar that had outgrown the phone it was meant for. With
 * seven destinations plus Settings it laid out eight tabs at a 46px minimum —
 * 368px of content in a 360px viewport, so the last tab was cut off and every
 * app route scrolled sideways. Eight labelled tabs is also simply too many to
 * read at that size.
 *
 * A drawer instead: one 44px button in the bar, and destinations at full width
 * with room for their labels. It scales with the user's font-size setting
 * because nothing here is a fixed-width column.
 *
 * Behaviour that a drawer has to get right, and that a tab bar never has to
 * think about:
 *
 *   - Escape closes it, and focus returns to the button that opened it.
 *   - Focus is trapped inside while it is open, so tabbing cannot wander into
 *     the page behind.
 *   - The page behind does not scroll.
 *   - The backdrop is a real button, so a tap outside closes it — and screen
 *     readers get the same affordance rather than an invisible div.
 *   - It renders into <body> through a portal. `position: fixed` normally
 *     anchors to the viewport, but any ancestor with a transform, a filter or
 *     will-change becomes the containing block instead — and the route wrapper
 *     .page-transition carries filter: blur(0px) and will-change: transform to
 *     drive its animation. Left in place, the drawer anchored to that wrapper
 *     and hung 14px off the right edge of the phone. Modal solves it the same
 *     way.
 */
export default function MobileNav({ open, onClose, links, footer, label = 'Menu', returnFocusTo }) {
  const panelRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement;
    // Move focus in, so the first Tab lands inside the drawer rather than on
    // whatever happened to be next in the page behind it.
    panelRef.current?.querySelector('a, button')?.focus();

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = panelRef.current?.querySelectorAll('a[href], button:not([disabled])');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      // Back to the hamburger, not to the top of the document.
      (returnFocusTo?.current ?? previouslyFocused)?.focus?.();
    };
  }, [open, onClose, returnFocusTo]);

  if (!open) return null;

  return createPortal(
    <div className="mobile-nav" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button type="button" className="mobile-nav-scrim" aria-label="Close menu" onClick={onClose} />

      <div className="mobile-nav-panel" ref={panelRef}>
        <div className="mobile-nav-head">
          <p id={titleId} className="mobile-nav-title">
            {label}
          </p>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close menu">
            <Icon name="close" size={20} />
          </button>
        </div>

        <nav className="mobile-nav-links" aria-label={label}>
          {links.map((l) =>
            l.href ? (
              // Marketing links are in-page anchors, not routes.
              <a key={l.href} href={l.href} className="mobile-nav-link" onClick={onClose}>
                {l.icon && <Icon name={l.icon} size={20} />}
                <span>{l.label}</span>
              </a>
            ) : (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                onClick={onClose}
                className={({ isActive }) => `mobile-nav-link ${isActive ? 'is-on' : ''}`}
              >
                {l.icon && <Icon name={l.icon} size={20} />}
                <span>
                  {l.label}
                  {l.description && <em>{l.description}</em>}
                </span>
              </NavLink>
            ),
          )}
        </nav>

        {footer && <div className="mobile-nav-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
