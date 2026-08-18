import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * The citation ribbon.
 *
 * SmartRecap's whole claim is that it does not invent things. Saying so in
 * marketing copy is cheap; this makes it visible. Hover or focus any line of
 * the recap and a lit thread is drawn from that line, across the page, to the
 * exact slide it came from — and the source panel it lands on lights up too.
 *
 * It is also the honest failure mode: a claim whose citations do not resolve to
 * a real chunk cannot draw a thread, and `Claim` renders it as unsupported
 * rather than as ordinary prose.
 */

const CitationContext = createContext(null);

export function CitationProvider({ chunks = [], children }) {
  const claims = useRef(new Map());
  const sources = useRef(new Map());
  const [active, setActive] = useState(null);
  const [pinned, setPinned] = useState(null);
  const [version, setVersion] = useState(0); // bumped when the DOM registry changes

  const chunkById = useMemo(() => new Map(chunks.map((c) => [c.id, c])), [chunks]);

  const registerClaim = useCallback((id, el) => {
    if (el) claims.current.set(id, el);
    else claims.current.delete(id);
    setVersion((v) => v + 1);
  }, []);

  const registerSource = useCallback((id, el) => {
    if (el) sources.current.set(id, el);
    else sources.current.delete(id);
    setVersion((v) => v + 1);
  }, []);

  const shown = pinned ?? active;

  const value = useMemo(
    () => ({
      chunkById,
      claims,
      sources,
      active,
      pinned,
      shown,
      version,
      setActive,
      togglePin: (id) => setPinned((p) => (p === id ? null : id)),
      registerClaim,
      registerSource,
    }),
    [chunkById, active, pinned, shown, version, registerClaim, registerSource],
  );

  return <CitationContext.Provider value={value}>{children}</CitationContext.Provider>;
}

export function useCitations() {
  const ctx = useContext(CitationContext);
  if (!ctx) throw new Error('Citation components must be used inside <CitationProvider>');
  return ctx;
}

/* ------------------------------------------------------------------------- */

/** One recap line, tethered to the slides it came from. */
export function Claim({ id, citations = [], confidence = 'grounded', children }) {
  const { chunkById, registerClaim, setActive, togglePin, shown, pinned } = useCitations();
  const ref = useRef(null);

  useLayoutEffect(() => {
    registerClaim(id, ref.current);
    return () => registerClaim(id, null);
  }, [id, registerClaim]);

  const resolved = citations.filter((c) => chunkById.has(c));
  const unsupported = resolved.length === 0;
  const isActive = shown === id;

  return (
    <li
      ref={ref}
      className={`claim ${isActive ? 'is-active' : ''} ${pinned === id ? 'is-pinned' : ''} ${unsupported ? 'is-unsupported' : ''}`}
      data-confidence={confidence}
      /* The ribbon and the source rail both read this attribute rather than
         threading the citation list through context on every render. */
      data-cites={resolved.join(',')}
      onMouseEnter={() => setActive(id)}
      onMouseLeave={() => setActive((a) => (a === id ? null : a))}
    >
      <p className="claim-text">{children}</p>
      <span className="claim-cites">
        {resolved.map((c) => (
          <button
            key={c}
            type="button"
            className="cite"
            onFocus={() => setActive(id)}
            onBlur={() => setActive((a) => (a === id ? null : a))}
            onClick={() => togglePin(id)}
            aria-pressed={pinned === id}
            aria-label={`${pinned === id ? 'Unpin' : 'Pin'} source ${chunkById.get(c).label}`}
          >
            {chunkById.get(c).label}
          </button>
        ))}
        {unsupported && (
          <span className="cite cite-missing" title="Nothing in your file backs this line up">
            Unsupported
          </span>
        )}
      </span>
    </li>
  );
}

/** One extracted passage in the source rail. */
export function SourceCard({ chunk }) {
  const { registerSource, shown, claims, chunkById } = useCitations();
  const ref = useRef(null);

  useLayoutEffect(() => {
    registerSource(chunk.id, ref.current);
    return () => registerSource(chunk.id, null);
  }, [chunk.id, registerSource]);

  // Lit when the currently-shown claim cites this chunk.
  const litBy = shown ? claims.current.get(shown)?.dataset : null;
  const isLit = !!shown && (litBy?.cites ?? '').split(',').includes(chunk.id);

  return (
    <article ref={ref} className={`source-card ${isLit ? 'is-lit' : ''}`} id={`src-${chunk.id}`}>
      <header className="source-head">
        <span className="source-label">{chunk.label}</span>
        {chunkById.has(chunk.id) && <span className="source-kind">from your file</span>}
      </header>
      <p className="source-text">{chunk.text}</p>
    </article>
  );
}

/**
 * The SVG overlay that draws the threads. Absolutely positioned over the
 * reader; recalculates on scroll, resize and whenever the active claim changes.
 */
export function CitationRibbon({ containerRef }) {
  const { shown, claims, sources, chunkById, version } = useCitations();
  const [paths, setPaths] = useState([]);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const raf = useRef(0);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    setBox({ w: cRect.width, h: cRect.height });

    if (!shown) {
      setPaths([]);
      return;
    }
    const claimEl = claims.current.get(shown);
    if (!claimEl) {
      setPaths([]);
      return;
    }

    const cites = (claimEl.dataset.cites ?? '').split(',').filter((c) => chunkById.has(c));
    const aRect = claimEl.getBoundingClientRect();
    const from = {
      x: aRect.right - cRect.left,
      y: aRect.top - cRect.top + aRect.height / 2,
    };

    const next = [];
    for (const id of cites) {
      const el = sources.current.get(id);
      if (!el) continue;
      const bRect = el.getBoundingClientRect();
      const to = { x: bRect.left - cRect.left, y: bRect.top - cRect.top + Math.min(28, bRect.height / 2) };
      // Horizontal-tangent cubic: the thread leaves the claim and arrives at
      // the source flat, so it reads as a connection rather than a scribble.
      const dx = Math.max(40, (to.x - from.x) * 0.55);
      next.push({
        id,
        d: `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`,
        from,
        to,
      });
    }
    setPaths(next);
  }, [containerRef, shown, claims, sources, chunkById]);

  useLayoutEffect(() => {
    measure();
  }, [measure, version]);

  useEffect(() => {
    const schedule = () => {
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(measure);
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const ro = new ResizeObserver(schedule);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => {
      cancelAnimationFrame(raf.current);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro.disconnect();
    };
  }, [measure, containerRef]);

  if (!box.w) return null;

  return (
    <svg className="ribbon" width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`} aria-hidden="true">
      <defs>
        <linearGradient id="ribbon-thread" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--series-1)" stopOpacity="0.15" />
          <stop offset="45%" stopColor="var(--series-2)" stopOpacity="0.95" />
          <stop offset="100%" stopColor="var(--series-3)" stopOpacity="0.95" />
        </linearGradient>
        <filter id="ribbon-glow" x="-30%" y="-200%" width="160%" height="500%">
          <feGaussianBlur stdDeviation="3.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {paths.map((p) => (
        <g key={p.id} className="ribbon-thread" filter="url(#ribbon-glow)">
          <path d={p.d} fill="none" stroke="url(#ribbon-thread)" strokeWidth="2" strokeLinecap="round" />
          <circle cx={p.from.x} cy={p.from.y} r="3.5" fill="var(--series-2)" />
          <circle cx={p.to.x} cy={p.to.y} r="4.5" fill="none" stroke="var(--series-3)" strokeWidth="2" />
        </g>
      ))}
    </svg>
  );
}
