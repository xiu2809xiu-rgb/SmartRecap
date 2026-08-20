import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.jsx';
import { useJobs } from '../lib/jobs.jsx';
import { enableCompletionNotifications } from '../lib/notifications.js';
import { useToast, Icon } from '../components/ui.jsx';
import { usePrefs } from '../lib/prefs.jsx';
import Mascot from '../mascot/Mascot.jsx';
import { FILE_TYPES, fileTypeOf, formatBytes } from '../lib/format.js';
import { LANGUAGES } from '../lib/languages.js';
import Stepper, { Step } from '../reactbits/Stepper.jsx';
import '../reactbits/Stepper.css';
import './upload.css';

const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPT = '.pdf,.pptx,.docx,.txt,.md,.png,.jpg,.jpeg';

const MODES = [
  {
    value: 'cram',
    title: 'Last-minute cram',
    icon: 'bolt',
    body: 'The eight or so things most likely to be examined, in the fewest words that still make sense. Roughly a two-minute read.',
  },
  {
    value: 'deep',
    title: 'Deep revision',
    icon: 'psychology',
    body: 'Keeps the worked reasoning, definitions and edge cases. Scanned pages use the heavier PaddleOCR path, and synthesis uses the strongest configured model.',
  },
];

export default function Upload() {
  const navigate = useNavigate();
  const toast = useToast();
  const { upsertMaterial } = useStore();
  const { registerJob } = useJobs();
  const { allowMascot } = usePrefs();

  const [file, setFile] = useState(null);
  const [mode, setMode] = useState('deep');
  const [moduleName, setModuleName] = useState('');
  const [language, setLanguage] = useState('en');
  const [dragging, setDragging] = useState(false);
  const [step, setStep] = useState(1);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  const accept = useCallback(
    (candidate) => {
      if (!candidate) return;
      if (candidate.size > MAX_BYTES) {
        setError(`That file is ${formatBytes(candidate.size)}. The limit is ${formatBytes(MAX_BYTES)} — try splitting the deck.`);
        return;
      }
      if (candidate.size === 0) {
        setError('That file is empty.');
        return;
      }
      setError(null);
      setFile(candidate);
      if (!moduleName) {
        // A leading "DBS_Week5" style prefix is usually the module code.
        const guess = candidate.name.replace(/\.[^.]+$/, '').split(/[_\-—–]/)[0].trim();
        if (guess.length > 2 && guess.length < 40) setModuleName(guess);
      }
    },
    [moduleName],
  );

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    accept(e.dataTransfer.files?.[0]);
  };

  /**
   * What each step needs before you may leave it.
   *
   * Step two is always satisfied because the depth has a sensible default —
   * forcing a choice you have already been given the right answer to is friction,
   * not validation. It is listed explicitly anyway so the rule is visible in one
   * place if that ever changes.
   */
  const canLeaveStep = (which) => {
    if (which === 1) return !!file;
    if (which === 2) return mode === 'cram' || mode === 'deep';
    return !!file;
  };

  const start = async () => {
    if (!file) {
      setError('Choose a file first.');
      return;
    }
    void enableCompletionNotifications();
    setBusy(true);
    setError(null);
    try {
      // Handles signing, sending, and re-signing if the instance role's
      // temporary credentials rotate mid-upload. See api.uploads.send.
      const materialId = await api.uploads.send(file);

      const { jobId } = await api.jobs.start({
        materialId,
        fileName: file.name,
        mode,
        module: moduleName || 'Unfiled',
        language,
      });

      registerJob({
        id: jobId,
        materialId,
        kind: 'recap',
        title: file.name.replace(/\.[^.]+$/, ''),
        language,
        stage: 'upload',
        stageLabel: 'Reading uploaded file',
        progress: 2,
      });

      upsertMaterial({
        id: materialId,
        title: file.name.replace(/\.[^.]+$/, ''),
        fileName: file.name,
        fileType: fileTypeOf(file.name),
        sizeBytes: file.size,
        module: moduleName || 'Unfiled',
        mode,
        language,
        status: 'processing',
        createdAt: new Date().toISOString(),
      });

      navigate(`/app/processing/${jobId}?material=${materialId}`);
    } catch (e) {
      setError(e.message ?? 'Upload failed.');
      toast.error(e.message ?? 'Upload failed.');
      setBusy(false);
    }
  };

  const type = file ? (FILE_TYPES[fileTypeOf(file.name)] ?? FILE_TYPES.pdf) : null;

  return (
    <div className="shell upload">
      <header className="upload-head">
        <div>
          <p className="eyebrow">New recap</p>
          <h1 className="upload-title">What are we working through?</h1>
          <p className="lede">
            Slides, notes, a scanned handout, or a photo of what you wrote in the lecture. Native text is extracted first;
            scanned pages automatically use local OCR, with PaddleOCR preferred in Deep revision mode.
          </p>
        </div>
        {allowMascot && <Mascot state={file ? 'reading' : 'wave'} size={170} shadow={false} />}
      </header>

      <div className="upload-stepper panel">
        <Stepper
          initialStep={1}
          backButtonText="Back"
          nextButtonText="Continue"
          onStepChange={setStep}
          onFinalStepCompleted={start}
          /* The real gate. Disabling the Continue button alone was not enough:
             the step indicators were also clickable, so you could jump straight
             to step three and submit with nothing selected. `canProceed` is
             consulted by the button AND by the indicators. */
          canProceed={canLeaveStep}
          /* Stay on step three when the submit fails, rather than advancing
             into a state with no content and no buttons. */
          advanceOnComplete={false}
          nextButtonProps={{ disabled: busy || !canLeaveStep(step) }}
        >
          {/* ------------------------------------------------------- step 1 */}
          <Step>
            <h2 className="step-title">Choose a file</h2>
            <div
              className={`dropzone ${dragging ? 'is-dragging' : ''} ${file ? 'has-file' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
              role="button"
              tabIndex={0}
              aria-label="Choose a file to upload"
            >
              <input
                ref={inputRef}
                type="file"
                accept={ACCEPT}
                hidden
                onChange={(e) => accept(e.target.files?.[0])}
              />
              {file ? (
                <div className="drop-file">
                  <span className={`file-badge is-${fileTypeOf(file.name)}`}>
                    <Icon name={type.icon} size={22} />
                  </span>
                  <div className="truncate">
                    <strong className="truncate">{file.name}</strong>
                    <p className="num">
                      {type.label} · {formatBytes(file.size)}
                    </p>
                  </div>
                  <button
                    className="icon-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFile(null);
                    }}
                    aria-label="Remove the selected file"
                  >
                    <Icon name="close" size={18} />
                  </button>
                </div>
              ) : (
                <>
                  <span className="drop-icon">
                    <Icon name="cloud_upload" size={30} />
                  </span>
                  <strong>Drop a file here, or click to browse</strong>
                  <p>PDF, PowerPoint, Word, plain text or an image — up to {formatBytes(MAX_BYTES)}</p>
                </>
              )}
            </div>

            {error && (
              <p className="field-error upload-error" role="alert">
                {error}
              </p>
            )}

            {!file && !error && (
              <p className="upload-hint">
                <Icon name="arrow_upward" size={15} />
                Choose a file to continue.
              </p>
            )}

            <p className="upload-privacy">
              <Icon name="lock" size={15} />
              Your file is stored privately. SmartRecap extracts text locally first, then sends only the extracted
              content needed for grounded AI synthesis. Deep mode may take several minutes for large scans.
            </p>
          </Step>

          {/* ------------------------------------------------------- step 2 */}
          <Step>
            <h2 className="step-title">How deep should the recap go?</h2>
            <div className="mode-grid">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  className={`mode-card ${mode === m.value ? 'is-on' : ''}`}
                  onClick={() => setMode(m.value)}
                  aria-pressed={mode === m.value}
                >
                  <span className="mode-icon">
                    <Icon name={m.icon} size={22} />
                  </span>
                  <strong>{m.title}</strong>
                  <p>{m.body}</p>
                </button>
              ))}
            </div>
          </Step>

          {/* ------------------------------------------------------- step 3 */}
          <Step>
            <h2 className="step-title">Last details</h2>
            <div className="field upload-field">
              <label htmlFor="module">Module or subject</label>
              <input
                id="module"
                className="input"
                value={moduleName}
                onChange={(e) => setModuleName(e.target.value)}
                placeholder="Database Systems"
              />
              <p className="field-hint">Used to group your library and to keep mastery scores separate per subject.</p>
            </div>

            <p className="field-hint upload-quiz-later">
              <Icon name="quiz" size={16} />
              Your notes are created first. Once they are ready, you can generate an Easy, Medium, or Hard conceptual
              quiz from the recap.
            </p>

            <div className="field upload-field">
              <label htmlFor="language">Preferred recap language</label>
              <select
                id="language"
                className="input"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
              >
                {LANGUAGES.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.endonym ? `${item.endonym} — ${item.label}` : item.label}
                  </option>
                ))}
              </select>
              <p className="field-hint">
                If translation is unavailable, SmartRecap keeps the verified English recap and tells you clearly instead of mislabelling it.
              </p>
            </div>

            <div className="upload-summary">
              <h3>Ready to run</h3>
              <dl>
                <div>
                  <dt>File</dt>
                  <dd className="truncate">{file?.name ?? 'None chosen'}</dd>
                </div>
                <div>
                  <dt>Recap depth</dt>
                  <dd>{MODES.find((m) => m.value === mode).title}</dd>
                </div>
                <div>
                  <dt>Module</dt>
                  <dd>{moduleName || 'Unfiled'}</dd>
                </div>
                <div>
                  <dt>Next step</dt>
                  <dd>Choose quiz difficulty after your notes are ready</dd>
                </div>
                <div>
                  <dt>Language</dt>
                  <dd>{LANGUAGES.find((item) => item.code === language)?.endonym ?? 'English'}</dd>
                </div>
              </dl>
            </div>

            {error && (
              <p className="field-error upload-error" role="alert">
                {error}
              </p>
            )}
          </Step>
        </Stepper>
      </div>
    </div>
  );
}
