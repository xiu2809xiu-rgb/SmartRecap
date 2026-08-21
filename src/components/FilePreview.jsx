import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui.jsx';
import { FILE_TYPES, fileTypeOf, formatBytes } from '../lib/format.js';
import './file-preview.css';

/**
 * What the chosen file actually looks like, before it is uploaded.
 *
 * This replaced a 22px icon and a filename sitting in a 220px drop zone, which
 * told you a file was attached but not *which* file — the thing you want to
 * check before spending a few minutes of processing on the wrong deck.
 *
 * Everything here runs on the local File object. Nothing is uploaded to draw a
 * preview, so a student who picked the wrong deck finds out before any of it
 * leaves the browser.
 *
 *   image  the image itself, through an object URL
 *   pdf    page one, rendered with pdf.js
 *   txt    the opening lines, set as text
 *   other  a sheet with the format's icon — PowerPoint and Word keep their
 *          content in a zip container that would need a second library to
 *          open, and the embedded thumbnail Office writes is optional, so
 *          there is nothing dependable to show
 *
 * pdf.js is imported dynamically: it is the single largest dependency in the
 * app and only ever needed on this screen, for one of the five formats.
 */

const PREVIEW_WIDTH = 420; // Rendered wide, displayed small, so it stays sharp.
const TEXT_PREVIEW_CHARS = 1200;

async function renderPdfCover(file, signal) {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  if (signal.cancelled) return null;

  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  const task = pdfjs.getDocument({
    data: await file.arrayBuffer(),
    // A cover preview does not need fonts fetched from a CDN, and this screen
    // has to work offline.
    disableFontFace: false,
    isEvalSupported: false,
  });

  try {
    const doc = await task.promise;
    if (signal.cancelled) return null;

    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: PREVIEW_WIDTH / base.width });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, canvas }).promise;
    if (signal.cancelled) return null;

    return { url: canvas.toDataURL('image/png'), pages: doc.numPages };
  } finally {
    task.destroy?.();
  }
}

export default function FilePreview({ file, onRemove }) {
  const kind = fileTypeOf(file.name);
  const type = FILE_TYPES[kind] ?? FILE_TYPES.txt;

  const [preview, setPreview] = useState({ state: 'loading' });
  // Object URLs hold a reference to the file's bytes until they are revoked.
  const objectUrl = useRef(null);

  useEffect(() => {
    const signal = { cancelled: false };
    setPreview({ state: 'loading' });

    const release = () => {
      if (objectUrl.current) {
        URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = null;
      }
    };
    release();

    (async () => {
      try {
        if (kind === 'image') {
          const url = URL.createObjectURL(file);
          objectUrl.current = url;
          // Read the real dimensions, which is the detail that tells you
          // whether a photographed page is going to be legible. Taken from the
          // File itself rather than by loading the object URL a second time:
          // under StrictMode the effect runs, cleans up and runs again, and a
          // probe image was still fetching a URL the cleanup had revoked.
          let size = null;
          try {
            const bitmap = await createImageBitmap(file);
            size = `${bitmap.width} × ${bitmap.height}`;
            bitmap.close?.();
          } catch {
            /* older browser, or a format it will not decode — the size line
               simply omits the dimensions */
          }
          if (signal.cancelled) return;
          setPreview({ state: 'image', url, detail: size });
          return;
        }

        if (kind === 'pdf') {
          const cover = await renderPdfCover(file, signal);
          if (signal.cancelled || !cover) return;
          setPreview({
            state: 'image',
            url: cover.url,
            detail: `${cover.pages} page${cover.pages === 1 ? '' : 's'}`,
          });
          return;
        }

        if (kind === 'txt') {
          const text = (await file.slice(0, 4096).text()).slice(0, TEXT_PREVIEW_CHARS);
          if (signal.cancelled) return;
          setPreview({ state: 'text', text: text.trim(), detail: null });
          return;
        }

        setPreview({ state: 'plain' });
      } catch {
        // A preview is a courtesy. If the file is encrypted, corrupt, or simply
        // something pdf.js will not open, the upload itself is still fine — so
        // this falls back to the plain sheet rather than surfacing an error.
        if (!signal.cancelled) setPreview({ state: 'plain' });
      }
    })();

    return () => {
      signal.cancelled = true;
      release();
    };
  }, [file, kind]);

  return (
    <div className="file-preview">
      <div className={`file-sheet is-${preview.state === 'image' ? 'art' : kind}`}>
        {preview.state === 'loading' && <span className="file-sheet-shimmer" aria-hidden="true" />}

        {preview.state === 'image' && (
          <img src={preview.url} alt={`Preview of ${file.name}`} className="file-sheet-art" />
        )}

        {preview.state === 'text' && (
          <pre className="file-sheet-text" aria-hidden="true">
            {preview.text}
          </pre>
        )}

        {preview.state === 'plain' && (
          <span className="file-sheet-glyph" aria-hidden="true">
            <Icon name={type.icon} size={34} />
          </span>
        )}
      </div>

      <div className="file-preview-meta">
        <strong className="truncate" title={file.name}>
          {file.name}
        </strong>
        <p className="num">
          {type.label} · {formatBytes(file.size)}
          {preview.detail ? ` · ${preview.detail}` : ''}
        </p>

        <div className="file-preview-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <Icon name="close" size={16} />
            Remove
          </button>
          <span className="file-preview-hint">Click anywhere to choose a different file</span>
        </div>
      </div>
    </div>
  );
}
