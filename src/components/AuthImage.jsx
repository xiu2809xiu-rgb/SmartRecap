import { useEffect, useState } from 'react';
import { apiAssetUrl, fetchAssetBlob } from '../lib/api.js';
import { Icon } from './ui.jsx';

/**
 * An <img> for pictures that live behind the session.
 *
 * Study illustrations are private, so their route requires a Bearer header —
 * which an image element cannot send. Pointing one straight at the URL returns
 * 401 and the browser shows a broken-image icon and the alt text, which is
 * exactly what it looked like: generation had worked all along and only the
 * display was failing.
 *
 * So the bytes are fetched with the header and handed over as an object URL,
 * revoked when this unmounts. An absolute URL needs none of that and is used
 * directly.
 */
export default function AuthImage({ path, alt, className, loading = 'lazy' }) {
  const external = /^https:\/\//i.test(path ?? '') || /^data:/i.test(path ?? '');
  const [url, setUrl] = useState(external ? apiAssetUrl(path) : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (external) {
      setUrl(apiAssetUrl(path));
      return undefined;
    }
    let cancelled = false;
    let objectUrl = null;
    setUrl(null);
    setFailed(false);
    fetchAssetBlob(path)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, external]);

  if (failed) {
    return (
      <span className={`auth-image is-failed ${className ?? ''}`.trim()} role="img" aria-label={alt}>
        <Icon name="broken_image" size={20} />
      </span>
    );
  }
  if (!url) return <span className={`auth-image is-loading ${className ?? ''}`.trim()} aria-hidden="true" />;
  return <img className={className} src={url} alt={alt} loading={loading} />;
}
