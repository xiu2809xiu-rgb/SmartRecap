import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import AuroraBackdrop from '../AuroraBackdrop.jsx';
import Mascot from '../mascot/Mascot.jsx';
import { Icon } from '../ui.jsx';
import { useAuth } from '../../lib/auth.jsx';
import { usePrefs } from '../../lib/prefs.jsx';
import { isDemo } from '../../lib/api.js';
import GooeyNav from '../../reactbits/GooeyNav.jsx';
import '../../reactbits/GooeyNav.css';
import MobileNav from './MobileNav.jsx';

/**
 * `data-surface` on <html> is what flips the whole token set between the dark
 * shell and the light study surface, including the body background. Setting it
 * on a wrapper div would leave the page behind the content still dark.
 */
export function useSurface(surface) {
  useEffect(() => {
    const root = document.documentElement;
    if (surface) root.dataset.surface = surface;
    else delete root.dataset.surface;
    return () => {
      delete root.dataset.surface;
    };
  }, [surface]);
}

export function Brand({ to = '/', compact = false }) {
  return (
    <Link to={to} className="brand" aria-label="SmartRecap home">
      {/* The mark is the logo file itself. The wordmark stays live text rather
          than the kit's lockup SVG, which buys two things an image cannot: it
          scales with the reader's font-size setting like every other label, and
          it takes its colour from the theme, so it stays legible on the light
          Daylight theme without shipping a second asset. Manrope at 600/800 and
          -0.01em tracking is what the kit's outlined wordmark was set in, so
          the result matches the lockup. */}
      <img className="brandmark" src="/brand/smartrecap-icon.svg" alt="" width="36" height="36" />
      {!compact && (
        <span className="brand-word">
          Smart<strong>Recap</strong>
        </span>
      )}
    </Link>
  );
}

function DemoBanner() {
  if (!isDemo) return null;
  return (
    <div className="demo-banner" role="note">
      <Icon name="science" size={16} />
      <span>
        Demo mode — every recap here is the same bundled sample, not one written from your own file.
      </span>
    </div>
  );
}

/* ------------------------------------------------------------- marketing */

const MARKETING_LINKS = [
  { label: 'How it works', href: '#how' },
  { label: 'Grounding', href: '#grounding' },
  { label: 'Features', href: '#features' },
  { label: 'Built on', href: '#stack' },
];

export function MarketingShell({ children }) {
  useSurface(null);
  const { isAuthed } = useAuth();
  const [scrolled, setScrolled] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const navToggleRef = useRef(null);
  const { allowEffects } = usePrefs();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="marketing">
      <AuroraBackdrop variant="aurora" className="backdrop-fixed" />
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className={`topbar ${scrolled ? 'is-scrolled' : ''}`}>
        <div className="shell topbar-inner">
          <Brand />
          <nav className="marketing-nav" aria-label="Page sections">
            {allowEffects ? (
              <GooeyNav items={MARKETING_LINKS} particleCount={12} animationTime={520} />
            ) : (
              <ul className="plain-nav">
                {MARKETING_LINKS.map((l) => (
                  <li key={l.href}>
                    <a href={l.href}>{l.label}</a>
                  </li>
                ))}
              </ul>
            )}
          </nav>
          <div className="row gap-2 topbar-actions">
            {isAuthed ? (
              <Link to="/app" className="btn btn-primary btn-sm">
                Open library
                <Icon name="arrow_forward" size={17} />
              </Link>
            ) : (
              <>
                <Link to="/login" className="btn btn-ghost btn-sm topbar-signin">
                  Sign in
                </Link>
                <Link to="/signup" className="btn btn-primary btn-sm">
                  Get started
                </Link>
              </>
            )}
          </div>
          <button
            type="button"
            className="nav-toggle"
            ref={navToggleRef}
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            aria-expanded={navOpen}
          >
            <Icon name="menu" size={22} />
          </button>
        </div>
      </header>

      {/* The section nav is a GooeyNav pill row that cannot fit a phone, so on
          narrow screens it is hidden and these anchors move into the drawer —
          the sections stay reachable rather than becoming desktop-only. */}
      <MobileNav
        open={navOpen}
        onClose={() => setNavOpen(false)}
        links={MARKETING_LINKS}
        label="Sections"
        returnFocusTo={navToggleRef}
        footer={
          isAuthed ? (
            <Link to="/app" className="btn btn-primary" onClick={() => setNavOpen(false)}>
              Open library
            </Link>
          ) : (
            <>
              <Link to="/signup" className="btn btn-primary" onClick={() => setNavOpen(false)}>
                Get started
              </Link>
              <Link to="/login" className="btn btn-ghost" onClick={() => setNavOpen(false)}>
                Sign in
              </Link>
            </>
          )
        }
      />

      <main id="main">{children}</main>

      <footer className="site-foot">
        <div className="shell">
          <div className="foot-top">
            <div className="foot-brand">
              <Brand />
              <p>Turn a lecture deck into a recap you can trust, and a quiz that proves you read it.</p>
            </div>
            <nav aria-label="Footer">
              <h3>Product</h3>
              <Link to="/signup">Create an account</Link>
              <Link to="/login">Sign in</Link>
              <a href="#how">How it works</a>
              <a href="#grounding">How grounding works</a>
            </nav>
            <nav aria-label="Project">
              <h3>Project</h3>
              <a href="https://github.com/RIHAN1009/smartrecap" rel="noreferrer noopener" target="_blank">
                Source repository
              </a>
              <Link to="/architecture">Architecture and live status</Link>
            </nav>
          </div>
          <div className="foot-bottom">
            <p>
              Built for the Nanyang Polytechnic Cloud Computing Club AWS hackathon — Problem
              Statement 1. By Team Stay Grounded.
            </p>
            {/* The React Bits credit that used to sit here is gone from the page,
                not from the project: it is a copy-and-own library under MIT, and
                the obligation is to keep the notice with the source. It lives in
                src/reactbits/LICENSE and src/reactbits/README.md. */}
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------- app */

const APP_LINKS = [
  { to: '/app', label: 'Library', icon: 'grid_view', end: true },
  { to: '/app/binders', label: 'Binders', icon: 'folder', description: 'Combine and manage multiple source PDFs' },
  { to: '/app/upload', label: 'New recap', icon: 'add_circle', description: 'Create a recap from one new upload' },
  { to: '/app/quizzes', label: 'Quizzes', icon: 'quiz' },
  { to: '/app/forum', label: 'Forum', icon: 'forum' },
  { to: '/app/social', label: 'Social', icon: 'diversity_3' },
  { to: '/app/progress', label: 'Progress', icon: 'insights' },
];

export function AppShell() {
  useSurface(null);
  const { user, logout, isGuest } = useAuth();
  const { allowMascot } = usePrefs();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const menuRef = useRef(null);
  const navToggleRef = useRef(null);

  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => setNavOpen(false), [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e) => !menuRef.current?.contains(e.target) && setMenuOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  return (
    <div className="app-shell">
      <AuroraBackdrop variant="dotgrid" className="backdrop-fixed backdrop-quiet" />
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="topbar is-app">
        <div className="shell topbar-inner">
          <Brand to="/app" />
          <nav className="app-nav" aria-label="Main">
            {APP_LINKS.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end} title={l.description} aria-label={l.description ? `${l.label}: ${l.description}` : l.label} className={({ isActive }) => `app-link ${isActive ? 'is-on' : ''}`}>
                <Icon name={l.icon} size={18} />
                <span className="app-link-label">{l.label}</span>
              </NavLink>
            ))}
          </nav>

          <div className="row gap-2 topbar-actions" ref={menuRef}>
            <Link to="/app/upload" className="btn btn-primary btn-sm topbar-cta">
              <Icon name="upload" size={17} />
              Upload
            </Link>
            <button
              className="avatar-btn"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Account menu"
            >
              <span className="avatar">{(user?.name ?? '?').slice(0, 1).toUpperCase()}</span>
            </button>
            {menuOpen && (
              <div className="menu panel-solid" role="menu">
                <div className="menu-head">
                  <strong>{user?.name}</strong>
                  <span>{isGuest ? 'Guest session' : user?.email}</span>
                </div>
                {isGuest && (
                  <Link to="/signup" role="menuitem" className="menu-item menu-item-accent">
                    <Icon name="person_add" size={18} />
                    Keep this work — create an account
                  </Link>
                )}
                <Link to="/app/settings" role="menuitem" className="menu-item">
                  <Icon name="tune" size={18} />
                  Settings
                </Link>
                <button
                  role="menuitem"
                  className="menu-item"
                  onClick={async () => {
                    await logout();
                    navigate('/');
                  }}
                >
                  <Icon name="logout" size={18} />
                  Sign out
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="nav-toggle"
            ref={navToggleRef}
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            aria-expanded={navOpen}
          >
            <Icon name="menu" size={22} />
          </button>
        </div>
        <DemoBanner />
      </header>

      <main id="main" className="app-main">
        <Outlet />
      </main>

      {/* Was a bottom tab bar. Seven destinations plus Settings laid out eight
          46px columns — 368px of content on a 360px phone, so the last tab was
          clipped and every app route scrolled sideways. A drawer holds all of
          them at readable width and grows with the font-size setting. */}
      <MobileNav
        open={navOpen}
        onClose={() => setNavOpen(false)}
        links={APP_LINKS}
        returnFocusTo={navToggleRef}
        footer={
          <>
            <Link to="/app/upload" className="btn btn-primary" onClick={() => setNavOpen(false)}>
              <Icon name="upload" size={18} />
              New recap
            </Link>
            <Link to="/app/settings" className="btn btn-ghost" onClick={() => setNavOpen(false)}>
              <Icon name="tune" size={18} />
              Settings
            </Link>
          </>
        }
      />

      {allowMascot && location.pathname === '/app' && (
        <div className="mascot-dock">
          <Mascot state="idle" size={128} shadow={false} />
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- study */

/**
 * The light reading surface. Same accents, same type, same motion language —
 * inverted luminance, because nobody should read 2,000 words of recap as white
 * text on near-black.
 */
export function StudyShell({ title, subtitle, subtitleAccessory, backTo = '/app', actions, children, wide = false }) {
  useSurface('study');
  return (
    <div className="study">
      <header className="study-bar">
        <div className={`shell study-bar-inner ${wide ? 'is-wide' : ''}`}>
          <Link to={backTo} className="icon-btn" aria-label="Back to library">
            <Icon name="arrow_back" size={20} />
          </Link>
          <div className="study-heading grow">
            <h1 className="study-title truncate">{title}</h1>
            {(subtitle || subtitleAccessory) && (
              <div className="study-meta-row">
                {subtitle && <p className="study-sub truncate">{subtitle}</p>}
                {subtitleAccessory}
              </div>
            )}
          </div>
          <div className="row gap-2 study-actions">{actions}</div>
        </div>
      </header>
      <main id="main">{children}</main>
    </div>
  );
}
