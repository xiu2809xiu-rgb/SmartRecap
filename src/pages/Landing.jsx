import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MarketingShell } from '../components/layout/Shells.jsx';
import AuroraBackdrop from '../components/AuroraBackdrop.jsx';
import ScrollProgress from '../components/ScrollProgress.jsx';
import PipelineScroll from '../components/PipelineScroll.jsx';
import AvatarShowcase from '../components/avatar/AvatarShowcase.jsx';
import Mascot from '../mascot/Mascot.jsx';
import { Icon } from '../components/ui.jsx';
import { usePrefs } from '../lib/prefs.jsx';
import { SAMPLE_CHUNKS, SAMPLE_RECAP } from '../data/seed.js';
import { CitationProvider, Claim, SourceCard, CitationRibbon } from '../components/Citations.jsx';

import SplitText from '../reactbits/SplitText.jsx';
import ShinyText from '../reactbits/ShinyText.jsx';
import GradientText from '../reactbits/GradientText.jsx';
import CountUp from '../reactbits/CountUp.jsx';
import BlurText from '../reactbits/BlurText.jsx';
import AnimatedContent from '../reactbits/AnimatedContent.jsx';
import FadeContent from '../reactbits/FadeContent.jsx';
import SpotlightCard from '../reactbits/SpotlightCard.jsx';
import MagicBento from '../reactbits/MagicBento.jsx';
import CardSwap, { Card } from '../reactbits/CardSwap.jsx';
import { LogoLoop } from '../reactbits/LogoLoop.jsx';
import StarBorder from '../reactbits/StarBorder.jsx';
import Magnet from '../reactbits/Magnet.jsx';
import ScrollFloat from '../reactbits/ScrollFloat.jsx';

import '../reactbits/ShinyText.css';
import '../reactbits/GradientText.css';
import '../reactbits/SpotlightCard.css';
import '../reactbits/MagicBento.css';
import '../reactbits/CardSwap.css';
import '../reactbits/LogoLoop.css';
import '../reactbits/StarBorder.css';
import '../reactbits/ScrollFloat.css';
import './landing.css';

const STEPS = [
  {
    n: '01',
    title: 'Drop in the deck',
    body: 'PDF, PowerPoint, Word, or a photo of handwritten notes. It is stored privately, and if there is no selectable text SmartRecap reads the words off the page for you.',
    icon: 'upload_file',
  },
  {
    n: '02',
    title: 'Every slide is kept separate',
    body: 'Slide 12 stays slide 12. Keeping that numbering is the whole trick — you cannot point back at where something came from if you threw away where it came from.',
    icon: 'content_cut',
  },
  {
    n: '03',
    title: 'Every line has to name its slide',
    body: 'The AI writes your recap and quiz against those numbered slides, and has to say which one each point came from. Anything it cannot attach to a slide is dropped before you see it.',
    icon: 'fact_check',
  },
];

const BENTO = [
  {
    label: 'Recap',
    title: 'Two depths',
    description: 'Last-minute cram gives you the eight things that will be on the paper. Deep revision keeps the worked reasoning.',
  },
  {
    label: 'Quiz',
    title: 'Adaptive retries',
    description: 'Miss a topic and it comes back weighted heavier next round, until the mastery bar clears 70%.',
  },
  {
    label: 'Recall',
    title: 'Spaced repetition',
    description: 'Key terms and missed questions become flashcards that come back at widening intervals, so revision spreads across the term instead of the night before.',
  },
  {
    label: 'Grounding',
    title: 'Nothing uncited ships',
    description: 'Anything the AI could not trace back to one of your slides is listed separately as dropped, with the reason it did not hold up.',
  },
  {
    label: 'Ask',
    title: 'Question the material',
    description: 'Ask anything about the deck and get an answer that quotes the slides, or an honest "that is not in here".',
  },
  {
    label: 'Export',
    title: 'Leaves the app cleanly',
    description: 'Markdown, printable PDF, or CSV that imports into Anki. Your revision should not be locked in a demo.',
  },
];

const STACK = [
  { node: <StackChip icon="cloud_upload" label="Amazon S3" />, title: 'Amazon S3' },
  { node: <StackChip icon="bolt" label="AWS Lambda" />, title: 'AWS Lambda' },
  { node: <StackChip icon="api" label="API Gateway" />, title: 'API Gateway' },
  { node: <StackChip icon="table" label="DynamoDB" />, title: 'DynamoDB' },
  { node: <StackChip icon="badge" label="Cognito" />, title: 'Amazon Cognito' },
  { node: <StackChip icon="document_scanner" label="Textract" />, title: 'Amazon Textract' },
  { node: <StackChip icon="volume_up" label="Polly" />, title: 'Amazon Polly' },
  { node: <StackChip icon="hub" label="OpenRouter" />, title: 'OpenRouter' },
  { node: <StackChip icon="memory" label="NVIDIA NIM" />, title: 'NVIDIA NIM' },
  { node: <StackChip icon="code" label="React 19" />, title: 'React 19' },
];

function StackChip({ icon, label }) {
  return (
    <span className="stack-chip">
      <Icon name={icon} size={18} />
      {label}
    </span>
  );
}

export default function Landing() {
  const { allowEffects, reduced } = usePrefs();
  const [mascotState, setMascotState] = useState('idle');
  const ribbonRef = useRef(null);

  // One section of the real recap, wired to the real ribbon — the landing page
  // demonstrates the grounding claim rather than asserting it.
  const demoSection = SAMPLE_RECAP.sections[2];
  const demoChunks = SAMPLE_CHUNKS.filter((c) => ['c6', 'c7', 'c8'].includes(c.id));

  return (
    <MarketingShell>
      <ScrollProgress />

      {/* ------------------------------------------------------------ hero */}
      <section className="hero">
        <div className="shell hero-grid">
          <div className="hero-copy">
            <p className="eyebrow hero-eyebrow">
              <ShinyText text="Automated class recap generator" speed={3.5} color="#8e80b4" shineColor="#00f0ff" />
            </p>

            {/* Each SplitText sits in its own block wrapper: the component sets
                `display: inline-block` inline, so two of them would otherwise
                reflow as one paragraph rather than two headline lines. */}
            <h1 className="hero-title">
              <span className="hero-line">
                <SplitText
                  text="Study what the"
                  tag="span"
                  splitType="chars"
                  delay={22}
                  duration={0.9}
                  textAlign="left"
                  from={{ opacity: 0, y: 60, rotateX: -40 }}
                  to={{ opacity: 1, y: 0, rotateX: 0 }}
                />
              </span>
              <span className="hero-line hero-line-accent">
                <SplitText
                  text="lecture actually said."
                  tag="span"
                  splitType="chars"
                  delay={22}
                  duration={0.9}
                  textAlign="left"
                  from={{ opacity: 0, y: 60, rotateX: -40 }}
                  to={{ opacity: 1, y: 0, rotateX: 0 }}
                />
              </span>
            </h1>

            <BlurText
              text="SmartRecap turns your slides and notes into a structured recap and a quiz that checks you read it. Every line of the recap points back at the slide it came from — and anything the AI could not trace to your material is dropped before it reaches you."
              className="lede hero-lede"
              animateBy="words"
              delay={12}
              direction="bottom"
            />

            <div className="row wrap gap-2 hero-cta">
              <Magnet padding={70} magnetStrength={5} disabled={!allowEffects}>
                <Link to="/signup" className="btn btn-primary btn-lg">
                  Upload your first deck
                  <Icon name="arrow_forward" size={19} />
                </Link>
              </Magnet>
              {allowEffects ? (
                <StarBorder as={Link} to="/app" color="#00f0ff" speed="5s" thickness={2} className="hero-star">
                  Try the sample deck
                </StarBorder>
              ) : (
                <Link to="/app" className="btn btn-ghost btn-lg">
                  Try the sample deck
                </Link>
              )}
            </div>

            <dl className="hero-stats">
              <div>
                <dt>Slides in the sample deck</dt>
                <dd className="num">
                  <CountUp to={24} duration={1.6} />
                </dd>
              </div>
              <div>
                <dt>Minutes to read its recap</dt>
                <dd className="num">
                  <CountUp to={5} duration={1.6} delay={0.15} />
                </dd>
              </div>
              <div>
                <dt>Uncited claims that ship</dt>
                <dd className="num">0</dd>
              </div>
            </dl>
          </div>

          <div
            className="hero-mascot"
            onMouseEnter={() => setMascotState('wave')}
            onMouseLeave={() => setMascotState('idle')}
          >
            <div className="hero-mascot-glow" aria-hidden="true" />
            <Mascot state={mascotState} size={380} />
            <p className="hero-mascot-note">
              <Icon name="drag_indicator" size={15} />
              Drag to turn — this is Rec, and it stays with you through the whole pipeline
            </p>
          </div>
        </div>
      </section>

      {/* --------------------------------------------- scroll-driven pipeline */}
      <PipelineScroll />

      {/* ------------------------------------------------------ how it works */}
      <section id="how" className="section how">
        <div className="shell how-grid">
          <div>
            <p className="eyebrow">How it works</p>
            <ScrollFloat containerClassName="h2-float" textClassName="section-title">
              Three steps, and the third one is the point
            </ScrollFloat>
            <div className="how-steps">
              {STEPS.map((s) => (
                <AnimatedContent key={s.n} distance={40} duration={0.7} threshold={0.25}>
                  <div className="how-step">
                    <span className="how-n num">{s.n}</span>
                    <div>
                      <h3>{s.title}</h3>
                      <p>{s.body}</p>
                    </div>
                  </div>
                </AnimatedContent>
              ))}
            </div>
          </div>

          <div className="how-visual">
            {allowEffects ? (
              <CardSwap width={420} height={300} cardDistance={52} verticalDistance={58} delay={3600} pauseOnHover skewAmount={5}>
                {STEPS.map((s) => (
                  <Card key={s.n} className="swap-card">
                    <span className="swap-icon">
                      <Icon name={s.icon} size={24} />
                    </span>
                    <span className="swap-n num">{s.n}</span>
                    <h4>{s.title}</h4>
                    <p>{s.body}</p>
                  </Card>
                ))}
              </CardSwap>
            ) : (
              <div className="how-visual-static">
                {STEPS.map((s) => (
                  <div key={s.n} className="swap-card is-static">
                    <span className="swap-icon">
                      <Icon name={s.icon} size={24} />
                    </span>
                    <h4>{s.title}</h4>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- grounding */}
      <section id="grounding" className="section grounding">
        <div className="shell">
          <div className="grounding-head">
            <p className="eyebrow">Grounding</p>
            <h2 className="section-title">
              Every line is tied to a slide.{' '}
              <GradientText colors={['#5D34D0', '#FF006E', '#00F0FF', '#5D34D0']} animationSpeed={9}>
                Hover one and watch.
              </GradientText>
            </h2>
            <p className="lede">
              This is the actual reader, running on the sample deck. The thread is not an illustration — it is drawn from
              the claim to the extracted passage it was written from, and a claim that cannot draw one is marked
              unsupported instead of being quietly presented as fact.
            </p>
          </div>

          <FadeContent blur duration={700} threshold={0.15}>
            <div className="grounding-demo panel" data-surface="study">
              <CitationProvider chunks={demoChunks}>
                <div className="reader-grid is-demo" ref={ribbonRef}>
                  <div className="reader-col">
                    <h3 className="demo-heading">{demoSection.heading}</h3>
                    <ul className="claims">
                      {demoSection.points.map((p) => (
                        <Claim key={p.id} id={p.id} citations={p.citations} confidence={p.confidence}>
                          {p.text}
                        </Claim>
                      ))}
                    </ul>
                  </div>
                  <aside className="source-rail" aria-label="Source passages">
                    <p className="rail-title">From your upload</p>
                    {demoChunks.map((c) => (
                      <SourceCard key={c.id} chunk={c} />
                    ))}
                  </aside>
                  {!reduced && <CitationRibbon containerRef={ribbonRef} />}
                </div>
              </CitationProvider>
            </div>
          </FadeContent>

          <div className="grounding-cards">
            <SpotlightCard className="ground-card" spotlightColor="rgba(255, 0, 110, 0.2)">
              <Icon name="rule" size={22} />
              <h3>Dropped, and shown as dropped</h3>
              <p>
                The sample deck produced two claims that no slide backed up. They are listed at the end of the recap
                with the reason rather than quietly deleted — knowing what the AI wanted to say and could not is
                worth seeing.
              </p>
            </SpotlightCard>
            <SpotlightCard className="ground-card" spotlightColor="rgba(0, 240, 255, 0.18)">
              <Icon name="quiz" size={22} />
              <h3>Unverifiable questions do not score</h3>
              <p>
                A question your material does not clearly answer is still shown and explained, but it does not count.
                Your score measures whether you learned the deck, not whether you guessed what the AI meant.
              </p>
            </SpotlightCard>
            <SpotlightCard className="ground-card" spotlightColor="rgba(93, 52, 208, 0.24)">
              <Icon name="swap_horiz" size={22} />
              <h3>It keeps working when one AI is busy</h3>
              <p>
                SmartRecap talks to two independent AI services. If the first is rate-limited or slow, it switches to
                the second automatically. You get your recap either way, and it stays free.
              </p>
            </SpotlightCard>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- features */}
      <section id="features" className="section features">
        <div className="shell">
          <p className="eyebrow">Features</p>
          <h2 className="section-title features-title">Built for the week before the exam</h2>
          <MagicBento
            cards={BENTO}
            glowColor="167, 139, 250"
            spotlightRadius={340}
            particleCount={10}
            enableTilt
            /* The component clamps copy to two lines by default, which cuts
               every description here mid-sentence. */
            textAutoHide={false}
            disableAnimations={!allowEffects}
          />
        </div>
      </section>

      {/* ------------------------------------------------------------ stack */}
      <section id="stack" className="section stack">
        <div className="shell">
          <p className="eyebrow">Built on</p>
          <h2 className="section-title">Built on AWS</h2>
          <p className="lede stack-lede">
            Your uploads, recaps and progress all live in AWS. Recaps are written by external free-tier AI models,
            called only from the server — no key ever reaches your browser, and your file never leaves storage.
          </p>
          <div className="stack-loop">
            <LogoLoop
              logos={STACK}
              speed={44}
              logoHeight={38}
              gap={26}
              pauseOnHover
              ariaLabel="Services and libraries this project uses"
            />
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------- cta */}
      {/* ------------------------------------------------------------ built by */}
      <AvatarShowcase />

      <section className="cta">
        <AuroraBackdrop variant="threads" className="cta-backdrop" opacity={0.5} />
        <div className="shell cta-inner">
          <h2 className="cta-title">
            Your next lecture is going to be 60 slides.
            <br />
            <GradientText colors={['#00F0FF', '#FF006E', '#5D34D0', '#00F0FF']} animationSpeed={7}>
              Be ready for it in five minutes.
            </GradientText>
          </h2>
          <div className="row wrap gap-2 center">
            <Link to="/signup" className="btn btn-primary btn-lg">
              Create a free account
              <Icon name="arrow_forward" size={19} />
            </Link>
            <Link to="/app" className="btn btn-ghost btn-lg">
              Try it as a guest
            </Link>
          </div>
          <p className="cta-note">No card, no model spend — the whole thing runs on free tiers.</p>
        </div>
      </section>
    </MarketingShell>
  );
}
