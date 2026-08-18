import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useStore } from '../lib/store.jsx';
import { useToast, Icon, Segmented } from '../components/ui.jsx';
import { usePrefs } from '../lib/prefs.jsx';
import Mascot from '../mascot/Mascot.jsx';
import { FILE_TYPES, fileTypeOf, formatBytes } from '../lib/format.js';
import Stepper, { Step } from '../reactbits/Stepper.jsx';
import '../reactbits/Stepper.css';
import './upload.css';

const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPT = '.pdf,.pptx,.ppt,.docx,.doc,.txt,.md,.png,.jpg,.jpeg,.webp';

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
    body: 'Keeps the worked reasoning, the definitions and the edge cases. Longer, and the one to use when you are learning the topic rather than refreshing it.',
  },
];

export default function Upload() {
  const navigate = useNavigate();
  const toast = useToast();
  const { upsertMaterial } = useStore();
  const { allowMascot } = usePrefs();

  const [file, setFile] = useState(null);
  const [mode, setMode] = useState('deep');
  const [moduleName, setModuleName] = useState('');
  const [quizLength, setQuizLength] = useState(10);
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

  const start = async () => {
    if (!file) {
      setError('Choose a file first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { materialId, uploadUrl } = await api.uploads.create({
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      });

      if (uploadUrl) await api.uploads.put(uploadUrl, file);

      const { jobId } = await api.jobs.start({
        materialId,
        fileName: file.name,
        mode,
        module: moduleName || 'Unfiled',
        quizLength,
      });

      upsertMaterial({
        id: materialId,
        title: file.name.replace(/\.[^.]+$/, ''),
        fileName: file.name,
        fileType: fileTypeOf(file.name),
        sizeBytes: file.size,
        module: moduleName || 'Unfiled',
        mode,
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
            Slides, notes, a scanned handout, or a photo of what you wrote in the lecture. If it is a scan or a
            photo, SmartRecap reads the text off it for you.
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
          /* Gate step one on actually having a file. Without this you can walk
             all three steps and only discover the problem at the end, which is
             the worst possible moment to be told. */
          nextButtonProps={{ disabled: busy || (step === 1 && !file) }}
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

            <p className="upload-privacy">
              <Icon name="lock" size={15} />
              Your file is stored privately — only you can open it. Only the text inside is read; the file itself is
              never handed to the AI.
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

            <div className="field upload-field">
              <label htmlFor="quizlen">Quiz length</label>
              <Segmented
                options={[
                  { value: 5, label: '5 questions' },
                  { value: 10, label: '10 questions' },
                  { value: 15, label: '15 questions' },
                ]}
                value={quizLength}
                onChange={setQuizLength}
                label="Quiz length"
              />
              <p className="field-hint">
                Questions your material does not clearly answer are still shown and explained, but they do not count
                toward your score — so the scored total can come out slightly lower.
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
                  <dt>Quiz</dt>
                  <dd className="num">{quizLength} questions</dd>
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
