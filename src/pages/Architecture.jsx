import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MarketingShell } from '../components/layout/Shells.jsx';
import { Icon, Spinner } from '../components/ui.jsx';
import { api, isDemo } from '../lib/api.js';
import './architecture.css';

/**
 * How SmartRecap is built.
 *
 * Deliberately not in the student navigation — a student revising for an exam
 * does not need to know which database their recap sits in, and every in-app
 * screen was cleaned of that language on purpose. This page is for the people
 * who do want to know: markers, judges, and whoever picks the project up next.
 *
 * The status column is live. It calls `GET /health?deep=1`, which probes each
 * AWS service with a read-only request, so what is on screen is what the
 * deployment can actually reach right now rather than what the diagram claims.
 */

const PIPELINE = [
  {
    step: '1',
    title: 'Upload',
    aws: 'Amazon S3',
    body: 'The browser asks the API for a presigned PUT URL and sends the file straight to a private bucket. It never passes through the application server, which keeps a 25 MB deck off the request path entirely.',
  },
  {
    step: '2',
    title: 'Extract',
    aws: 'Amazon Textract',
    body: 'PDF, PowerPoint, Word and plain text are parsed for their text layer, page by page. When a file turns out to be scans or photos — under 40 characters a page — it routes to Textract for OCR instead of failing.',
  },
  {
    step: '3',
    title: 'Chunk',
    aws: '—',
    body: 'Every page or slide becomes a numbered chunk that keeps its own label. That numbering is the whole reason citation is possible later: you cannot point at where something came from if you threw away where it came from.',
  },
  {
    step: '4',
    title: 'Generate',
    aws: 'OpenRouter → NVIDIA NIM',
    body: 'The chunks go to a model as constrained JSON, and every claim it writes must carry the chunk ids it came from. Two providers with automatic failover, both on free tiers — Bedrock is not available in AWS Academy Learner Lab.',
  },
  {
    step: '5',
    title: 'Ground',
    aws: '—',
    body: 'Every claim is checked twice: the cited chunk must exist, and the claim must share the distinctive vocabulary of that chunk, weighted by inverse document frequency. Anything that fails is dropped from the recap and listed with the reason.',
  },
  {
    step: '6',
    title: 'Translate',
    aws: '—',
    body: 'If the student asked to read their recap in Chinese, Malay or Tamil, the lines that survived step 5 are translated — and only those. Citations are never touched, so a translated point still points at the original slide, and the source panel still quotes it in the original words.',
  },
  {
    step: '7',
    title: 'Store',
    aws: 'Amazon DynamoDB',
    body: 'Recap, quiz, chunk index and quiz attempts land in a single table keyed by user. Everything a student has made stays in one partition, so their library is one query.',
  },
];

const SERVICE_ROLES = {
  DynamoDB: 'Recaps, quizzes, attempts, flashcard schedules',
  S3: 'Uploaded files, private, expiring after 30 days',
  Cognito: 'Accounts and sign-in',
  Textract: 'OCR for scans and photos of handwritten notes',
  Polly: 'Read-aloud of a finished recap',
};

export default function Architecture() {
  const [status, setStatus] = useState({ state: 'loading' });

  useEffect(() => {
    if (isDemo) {
      setStatus({ state: 'demo' });
      return;
    }
    api
      .health({ deep: true })
      .then((data) => setStatus({ state: 'ready', data }))
      .catch((e) => setStatus({ state: 'error', message: e?.message ?? 'Could not reach the API.' }));
  }, []);

  return (
    <MarketingShell>
      <div className="shell arch">
        <header className="arch-head">
          <p className="eyebrow">How it is built</p>
          <h1>Seven steps, and the fifth one is the product</h1>
          <p className="lede">
            SmartRecap turns a lecture file into a recap you can check. Anything the model cannot trace back to your
            own material is removed before you see it — that constraint is what shapes every decision below.
          </p>
        </header>

        {/* ------------------------------------------------------ pipeline */}
        <ol className="arch-pipeline">
          {PIPELINE.map((s) => (
            <li key={s.step} className="arch-step">
              <div className="arch-step-mark">
                <span className="num">{s.step}</span>
              </div>
              <div className="arch-step-body">
                <div className="arch-step-head">
                  <h2>{s.title}</h2>
                  {s.aws !== '—' && <span className="chip arch-chip">{s.aws}</span>}
                </div>
                <p>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        {/* -------------------------------------------------------- status */}
        <section className="arch-status panel">
          <header className="arch-status-head">
            <div>
              <h2>Live service status</h2>
              <p>
                Read-only checks against the deployed backend, run when this page loaded. Nothing here is a
                screenshot.
              </p>
            </div>
            {status.state === 'ready' && (
              <span className={`chip ${status.data.aws?.services?.every((s) => s.ok) ? 'chip-good' : 'chip-warn'}`}>
                {status.data.aws?.services?.filter((s) => s.ok).length ?? 0} of{' '}
                {status.data.aws?.services?.length ?? 0} reachable
              </span>
            )}
          </header>

          {status.state === 'loading' && (
            <p className="arch-status-note">
              <Spinner size={16} /> Checking…
            </p>
          )}

          {status.state === 'demo' && (
            <p className="arch-status-note">
              <Icon name="science" size={16} />
              Running in demo mode — no backend is connected, so there is nothing to probe. Set{' '}
              <code>VITE_API_BASE_URL</code> to point this at a deployment.
            </p>
          )}

          {status.state === 'error' && (
            <p className="arch-status-note is-bad">
              <Icon name="error" size={16} />
              {status.message}
            </p>
          )}

          {status.state === 'ready' && (
            <>
              <ul className="arch-services">
                {(status.data.aws?.services ?? []).map((s) => (
                  <li key={s.name} className={s.ok ? 'is-ok' : 'is-bad'}>
                    <span className="arch-service-dot">
                      <Icon name={s.ok ? 'check' : 'close'} size={13} />
                    </span>
                    <div>
                      <strong>{s.name}</strong>
                      <span>{SERVICE_ROLES[s.name] ?? ''}</span>
                    </div>
                    <span className="arch-service-ms num">{s.ok ? `${s.ms} ms` : s.error}</span>
                  </li>
                ))}
              </ul>
              <dl className="arch-meta">
                <div>
                  <dt>Region</dt>
                  <dd>{status.data.region}</dd>
                </div>
                <div>
                  <dt>AI providers configured</dt>
                  <dd>{status.data.providers?.length ? status.data.providers.join(' → ') : 'none'}</dd>
                </div>
                <div>
                  <dt>API uptime</dt>
                  <dd className="num">{Math.round((status.data.uptimeSeconds ?? 0) / 60)} min</dd>
                </div>
              </dl>
            </>
          )}
        </section>

        {/* ------------------------------------------------------ decisions */}
        <section className="arch-notes">
          <h2 className="arch-notes-title">Decisions worth asking about</h2>
          <div className="arch-note-grid">
            <article>
              <h3>Which models, and where they run</h3>
              <p>
                Generation runs on OpenRouter with automatic failover to NVIDIA NIM — both free tiers, both called
                only from the server, so no key ever reaches the browser. Bedrock is not available in AWS Academy
                Learner Lab. The AWS AI in the pipeline is Textract, which reads text off a scan or a photo of
                handwritten notes, and Polly, which reads a finished recap aloud.
              </p>
            </article>
            <article>
              <h3>What the AI is actually for</h3>
              <p>
                Not summarising — any model does that. The work is in what happens to the output afterwards: every
                claim must name the chunk it came from, resolve to a real one, and share that chunk's distinctive
                vocabulary. Whatever fails is shown to the student with the reason rather than quietly deleted, and
                every recap records how many points it kept and how many it dropped. The model is one stage of seven;
                the other six exist to make its output checkable.
              </p>
            </article>
            <article>
              <h3>Why student code never reaches our server</h3>
              <p>
                The practice panel runs Python through WebAssembly and JavaScript natively, both inside a Web Worker
                in the student&rsquo;s own browser. A server-side runner would mean accepting arbitrary code from the
                internet onto a Learner Lab instance we cannot properly isolate — the blast radius of getting that
                wrong is the entire AWS account. This has none of that exposure, costs nothing to operate, and keeps
                working when the lab session ends. The trade is Python and JavaScript only.
              </p>
            </article>
            <article>
              <h3>Why translation runs last</h3>
              <p>
                Grounding compares a claim against the slide it cites by shared vocabulary. Ask the model to write the
                recap in Malay and it would compare a Malay sentence to an English slide, share nothing, and either
                delete the entire recap or — worse — wave it through while reporting that it had checked. So the recap
                is written, cited and checked in the material's own language, and only the lines that survived are
                translated. If the translation call fails, you get the recap in its original wording rather than no
                recap.
              </p>
            </article>
            <article>
              <h3>Why generation is asynchronous</h3>
              <p>
                A recap takes 20 to 40 seconds and API Gateway caps a request at 29. Starting a job writes a row and
                returns immediately; the client polls it. On EC2 the same pipeline runs in-process, because a
                long-lived server has no such cap.
              </p>
            </article>
            <article>
              <h3>Why one DynamoDB table</h3>
              <p>
                Every access pattern here is either "everything belonging to one student" or "one item by id", and a
                partition key plus sort key covers both. A second table would add cost and deploy surface for nothing.
              </p>
            </article>
            <article>
              <h3>What happens when the AI is wrong</h3>
              <p>
                It gets removed. A claim whose citation does not resolve, or that does not share vocabulary with the
                chunk it cites, never reaches the recap — it is listed separately as dropped, with the reason. Quiz
                questions the material does not settle are shown but excluded from your score.
              </p>
            </article>
          </div>
        </section>

        <p className="arch-foot">
          Full write-ups live in the repository: <code>docs/ARCHITECTURE.md</code>,{' '}
          <code>docs/EC2-DEPLOYMENT.md</code> and <code>docs/LEARNER-LAB-LIMITS.md</code>.{' '}
          <Link to="/">Back to the homepage</Link>
        </p>
      </div>
    </MarketingShell>
  );
}
