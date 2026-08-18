import { useEffect, useRef, useState } from 'react';
import { useScroll, useMotionValueEvent } from 'motion/react';
import { Icon } from './ui.jsx';
import { usePrefs } from '../lib/prefs.jsx';
import './pipeline-scroll.css';

/**
 * The pipeline, advanced by scroll position rather than by a timer.
 *
 * The section is taller than the viewport and its inner panel is sticky, so
 * scrolling through it holds the panel in place and moves through the seven
 * stages instead. Scroll *drives* the state here — it is not a reveal that
 * fires once on entry — which means you can scrub back and forth and the stage
 * follows your thumb. That is the difference between a page that animates and a
 * page that responds.
 *
 * The story is deliberately ordered to land on step five. Steps one to four are
 * what any summariser does; grounding is the product, and the copy builds to it.
 *
 * Under reduced motion the whole mechanism is dropped: the section stops being
 * taller than the viewport, nothing is sticky, and all seven stages render as a
 * plain list. Sticky-scroll hijacking is exactly what someone who asks for
 * reduced motion is asking to be spared.
 */

const STAGES = [
  {
    id: 'upload',
    label: 'Upload',
    aws: 'Amazon S3',
    icon: 'cloud_upload',
    body: 'Your slides go straight to private storage. The file never passes through our server.',
  },
  {
    id: 'extract',
    label: 'Read the text',
    aws: 'Amazon Textract',
    icon: 'document_scanner',
    body: 'Page by page. If it turns out to be a scan or a photo of handwriting, the words get read off the image instead.',
  },
  {
    id: 'chunk',
    label: 'Keep the slide numbers',
    aws: null,
    icon: 'tag',
    body: 'Every page becomes a numbered piece that remembers where it came from. Nothing later works without this.',
  },
  {
    id: 'generate',
    label: 'Write the recap',
    aws: 'OpenRouter → NVIDIA NIM',
    icon: 'auto_awesome',
    body: 'The model has to name the slide behind every single line it writes. Two providers, so a rate limit is not a dead end.',
  },
  {
    id: 'ground',
    label: 'Check every claim',
    aws: null,
    icon: 'rule',
    body: 'The cited slide must exist, and must actually discuss the thing being claimed. Whatever fails is cut from the recap and shown to you with the reason.',
    keystone: true,
  },
  {
    id: 'translate',
    label: 'Translate, if you asked',
    aws: null,
    icon: 'translate',
    body: 'Chinese, Malay or Tamil — after the check, never instead of it, so the citations still point at your original slides.',
  },
  {
    id: 'store',
    label: 'Into your library',
    aws: 'Amazon DynamoDB',
    icon: 'inventory_2',
    body: 'Recap, quiz, flashcards and sources. Everything you have made is one query away.',
  },
];

export default function PipelineScroll() {
  const sectionRef = useRef(null);
  const { reduced } = usePrefs();
  const [active, setActive] = useState(0);

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    // Starts advancing when the panel settles into place and finishes as the
    // section leaves, so the full scroll distance maps onto the stages rather
    // than a fraction of it.
    offset: ['start start', 'end end'],
  });

  useMotionValueEvent(scrollYProgress, 'change', (value) => {
    if (reduced) return;
    // A small lead-in so stage one is readable before anything moves, then an
    // even split across the rest.
    const index = Math.min(STAGES.length - 1, Math.max(0, Math.floor(value * STAGES.length * 1.04)));
    setActive((current) => (current === index ? current : index));
  });

  // Reduced motion shows the whole list, so there is no single active stage.
  useEffect(() => {
    if (reduced) setActive(-1);
  }, [reduced]);

  const stage = STAGES[active] ?? STAGES[0];

  if (reduced) {
    return (
      <section id="pipeline" className="section pipe pipe-static">
        <div className="shell">
          <p className="eyebrow">What happens to your file</p>
          <h2 className="section-title">Seven steps, and the fifth one is the product</h2>
          <ol className="pipe-list">
            {STAGES.map((s, i) => (
              <li key={s.id} className={s.keystone ? 'is-keystone' : ''}>
                <span className="pipe-list-num num">{i + 1}</span>
                <div>
                  <h3>
                    {s.label}
                    {s.aws && <span className="chip pipe-chip">{s.aws}</span>}
                  </h3>
                  <p>{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>
    );
  }

  return (
    <section
      id="pipeline"
      className={`pipe ${stage.keystone ? 'is-keystone-active' : ''}`}
      ref={sectionRef}
      style={{ height: `${STAGES.length * 70}vh` }}
    >
      <div className="pipe-sticky">
        <div className="shell pipe-inner">
          <header className="pipe-head">
            <p className="eyebrow">What happens to your file</p>
            <h2 className="section-title">Seven steps, and the fifth one is the product</h2>
          </header>

          <div className="pipe-body">
            {/* The rail is the progress indicator and the nav at once. */}
            <ol className="pipe-rail" aria-label="Pipeline stages">
              {STAGES.map((s, i) => (
                <li
                  key={s.id}
                  className={`pipe-step ${i === active ? 'is-on' : ''} ${i < active ? 'is-done' : ''} ${
                    s.keystone ? 'is-keystone' : ''
                  }`}
                >
                  <span className="pipe-dot">
                    {i < active ? <Icon name="check" size={12} /> : <span className="pipe-dot-core" />}
                  </span>
                  <span className="pipe-step-label">{s.label}</span>
                </li>
              ))}
            </ol>

            <div className={`pipe-card ${stage.keystone ? 'is-keystone' : ''}`} aria-live="polite">
              <span className="pipe-card-icon">
                <Icon name={stage.icon} size={26} />
              </span>
              <p className="pipe-card-step num">
                Step {active + 1} of {STAGES.length}
              </p>
              <h3 className="pipe-card-title">{stage.label}</h3>
              <p className="pipe-card-body">{stage.body}</p>
              {stage.aws && <span className="chip pipe-chip">{stage.aws}</span>}
              {stage.keystone && (
                <p className="pipe-card-flag">
                  <Icon name="verified" size={15} />
                  This is the step the whole product is for.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
