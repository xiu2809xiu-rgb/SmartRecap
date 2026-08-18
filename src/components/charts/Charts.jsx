import { useId, useMemo, useRef, useState } from 'react';
import { Icon } from '../ui.jsx';

/**
 * Study analytics.
 *
 * Colour follows the job the data is doing, not the brand:
 *  - Mastery bars encode one measure, so every bar is one hue and length does
 *    the work. "Needs work" is a status chip with an icon and a label, never a
 *    second colour smuggled in as meaning.
 *  - The score trend is a single series, so it carries no legend — the heading
 *    names it.
 *  - The activity heatmap is magnitude, so it uses one hue stepped light→dark.
 *
 * Palette validated with the data-viz validator against both surfaces:
 *   dark  #8F7BF5 #F0407F #0FA5BA on #0B0616 — six checks PASS
 *   light #6D4FE0 #D01B63 #0098B0 on #F6F4FB — six checks PASS
 */

/* ------------------------------------------------------------------ tiles */

export function StatTile({ label, value, unit, hint, icon, tone = 'neutral' }) {
  return (
    <div className={`stat-tile tone-${tone}`}>
      {icon && (
        <span className="stat-icon">
          <Icon name={icon} size={19} />
        </span>
      )}
      <p className="stat-label">{label}</p>
      <p className="stat-value num">
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </p>
      {hint && <p className="stat-hint">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------ mastery bars */

export function MasteryBars({ topics, threshold = 70 }) {
  if (!topics.length) {
    return <p className="chart-empty">Take a quiz and your per-topic mastery appears here.</p>;
  }

  return (
    <div className="mastery">
      {topics.map((t) => {
        const weak = t.mastery < threshold;
        return (
          <div key={t.topic} className="mastery-row">
            <div className="mastery-head">
              <span className="mastery-topic truncate" title={t.topic}>
                {t.topic}
              </span>
              {weak && (
                <span className="chip chip-warn mastery-flag">
                  <Icon name="priority_high" size={13} />
                  Needs work
                </span>
              )}
              <span className="mastery-value num">{t.mastery}%</span>
            </div>
            <div className="mastery-track">
              {/* 4px rounded data-end anchored to the baseline. */}
              <div className="mastery-fill" style={{ width: `${Math.max(2, t.mastery)}%` }} />
              <div className="mastery-threshold" style={{ left: `${threshold}%` }} aria-hidden="true" />
            </div>
            <p className="mastery-detail num">
              {t.correct} of {t.total} correct
            </p>
          </div>
        );
      })}
      <p className="chart-note">
        The dashed line marks {threshold}% — the point below which SmartRecap starts re-surfacing a topic in your quizzes.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------- score trend */

export function ScoreTrend({ attempts, height = 190 }) {
  const gid = useId().replace(/:/g, '');
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);

  const points = useMemo(
    () => [...attempts].reverse().map((a, i) => ({ i, score: a.score, at: a.at, correct: a.correct, total: a.total })),
    [attempts],
  );

  if (points.length < 2) {
    return <p className="chart-empty">Two or more quiz attempts are needed before a trend means anything.</p>;
  }

  const W = 640;
  const H = height;
  const pad = { t: 14, r: 16, b: 26, l: 34 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const x = (i) => pad.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v) => pad.t + ih - (v / 100) * ih;

  const line = points.map((p, i) => `${i ? 'L' : 'M'} ${x(p.i)} ${y(p.score)}`).join(' ');
  const area = `${line} L ${x(points.at(-1).i)} ${pad.t + ih} L ${x(0)} ${pad.t + ih} Z`;

  const onMove = (e) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const rel = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.max(0, Math.min(points.length - 1, Math.round(((rel - pad.l) / iw) * (points.length - 1))));
    setHover(idx);
  };

  const hp = hover != null ? points[hover] : null;

  return (
    <div className="chart" ref={wrapRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Quiz score over time">
        <defs>
          <linearGradient id={`fill-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--series-1)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--series-1)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Recessive grid */}
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="grid-line" />
            <text x={pad.l - 8} y={y(v) + 4} className="axis-label num" textAnchor="end">
              {v}
            </text>
          </g>
        ))}

        <path d={area} fill={`url(#fill-${gid})`} />
        <path d={line} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

        {points.map((p) => (
          <circle
            key={p.i}
            cx={x(p.i)}
            cy={y(p.score)}
            r={hover === p.i ? 6 : 4.5}
            fill="var(--series-1)"
            stroke="var(--ground)"
            strokeWidth="2"
          />
        ))}

        {hp && (
          <line x1={x(hp.i)} x2={x(hp.i)} y1={pad.t} y2={pad.t + ih} className="crosshair" />
        )}
      </svg>

      {hp && (
        <div className="chart-tip" style={{ left: `${(x(hp.i) / W) * 100}%` }}>
          <strong className="num">{hp.score}%</strong>
          <span className="num">
            {hp.correct}/{hp.total} correct
          </span>
          <span>{new Date(hp.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- heatmap */

const LEVELS = ['var(--seq-0)', 'var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)'];
const level = (n) => (n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 3 : 4);
const DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];

export function StudyHeatmap({ cells }) {
  const [hover, setHover] = useState(null);
  const weeks = useMemo(() => {
    const out = [];
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
    return out;
  }, [cells]);

  const active = cells.filter((c) => !c.future && c.count > 0).length;

  return (
    <div className="heatmap">
      <div className="heatmap-grid">
        <div className="heatmap-days">
          {DAY_LABELS.map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>
        <div className="heatmap-weeks">
          {weeks.map((week, wi) => (
            <div className="heatmap-week" key={wi}>
              {week.map((cell) => (
                <button
                  key={cell.key}
                  type="button"
                  className={`heatmap-cell ${cell.future ? 'is-future' : ''}`}
                  style={{ background: cell.future ? 'transparent' : LEVELS[level(cell.count)] }}
                  onMouseEnter={() => setHover(cell)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(cell)}
                  onBlur={() => setHover(null)}
                  aria-label={`${cell.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}: ${cell.count} quiz ${cell.count === 1 ? 'attempt' : 'attempts'}`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="heatmap-foot">
        <p className="num">{active} active days in the last 12 weeks</p>
        <div className="heatmap-legend">
          <span>Less</span>
          {LEVELS.map((c, i) => (
            <i key={i} style={{ background: c }} />
          ))}
          <span>More</span>
        </div>
      </div>

      {hover && !hover.future && (
        <p className="heatmap-readout num" role="status">
          {hover.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} — {hover.count}{' '}
          {hover.count === 1 ? 'attempt' : 'attempts'}
        </p>
      )}
    </div>
  );
}

/* --------------------------------------------------------- results donut */

/** Single hero number with a ring. One value, so no legend and no tooltip. */
export function ScoreRing({ score, size = 168, label }) {
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  const tone = score >= 80 ? 'good' : score >= 50 ? 'warn' : 'bad';
  return (
    <div className="score-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${score} percent`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--seq-0)" strokeWidth="10" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`var(--${tone})`}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${(score / 100) * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="score-ring-center">
        <strong className="num">{score}%</strong>
        {label && <span>{label}</span>}
      </div>
    </div>
  );
}
