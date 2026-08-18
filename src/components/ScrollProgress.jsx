import { motion, useScroll, useSpring } from 'motion/react';
import { usePrefs } from '../lib/prefs.jsx';
import './scroll-progress.css';

/**
 * How far through the page you are.
 *
 * A marketing page that tells a story from top to bottom should say how much
 * story is left. Bound to scroll position rather than animated on a timer, and
 * smoothed with a spring so a trackpad's jitter does not show as a twitching
 * bar.
 *
 * Under reduced motion the bar is still drawn and still accurate — it is
 * information, not decoration — but the spring is dropped so it tracks scroll
 * exactly rather than easing towards it.
 */
export default function ScrollProgress() {
  const { reduced } = usePrefs();
  const { scrollYProgress } = useScroll();
  const smoothed = useSpring(scrollYProgress, { stiffness: 120, damping: 28, restDelta: 0.001 });

  return (
    <motion.div
      className="scroll-progress"
      style={{ scaleX: reduced ? scrollYProgress : smoothed }}
      aria-hidden="true"
    />
  );
}
