import { useEffect, useState } from 'react';
import { usePrefs } from '../../lib/prefs.jsx';
import './thought-bubble.css';

/**
 * What the avatar is thinking, changing with the animation.
 *
 * A DOM overlay rather than something drawn in the canvas: text in WebGL means
 * either a texture atlas or an extra font payload, and neither can be selected,
 * translated by the browser, or read by a screen reader. This is a paragraph.
 *
 * It is `aria-hidden`. The thoughts are decoration — flavour on a login screen
 * — and announcing a new one every few seconds would be a far worse experience
 * than silence for anyone using a screen reader.
 */

// Long enough to read a sentence, short enough that the bubble is not still
// there when the pose that prompted it has finished.
const HOLD_MS = 4200;

export default function ThoughtBubble({ text }) {
  const { reduced } = usePrefs();
  const [shown, setShown] = useState(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!text) return undefined;

    // Swap the words only while the bubble is invisible, so a change never
    // happens mid-read.
    setVisible(false);
    const swap = setTimeout(() => {
      setShown(text);
      setVisible(true);
    }, 260);

    const hide = setTimeout(() => setVisible(false), 260 + HOLD_MS);
    return () => {
      clearTimeout(swap);
      clearTimeout(hide);
    };
  }, [text]);

  if (!shown) return null;

  return (
    <div
      className={`thought ${visible ? 'is-in' : ''} ${reduced ? 'is-still' : ''}`}
      aria-hidden="true"
    >
      {/* Two trailing dots, scaled down toward the figure — the shorthand that
          makes a rounded rectangle read as a thought rather than as a tooltip. */}
      <span className="thought-dot thought-dot-2" />
      <span className="thought-dot thought-dot-1" />
      <p className="thought-body">{shown}</p>
    </div>
  );
}
