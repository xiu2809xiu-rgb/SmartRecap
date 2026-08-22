import { useEffect, useRef } from 'react';
import './ParticleText.css';
import { usePrefs } from '../lib/prefs.jsx';

/**
 * Text rendered as a field of particles that scatter away from the cursor.
 *
 * Deliberately canvas 2D rather than WebGL. The one page this exists for is the
 * 404, which is the page most likely to be reached by something already going
 * wrong — an old link, a locked-down browser, a machine with no GPU. A hero
 * that needs a WebGL context to say "page not found" is a hero that can fail to
 * say it. Canvas 2D has no such failure mode, and the whole effect costs
 * nothing beyond what is already in the bundle.
 *
 * How it works: the text is drawn once to an offscreen canvas, its pixels are
 * sampled on a grid, and every opaque sample becomes a particle whose home is
 * that pixel. Particles spring home and are pushed away from the pointer, so
 * the glyphs are always legible even mid-scatter.
 *
 * Under reduced motion it paints the particles at their home positions once and
 * never starts a loop — the composition survives, the movement does not.
 */

/* Sampling every pixel would be tens of thousands of particles for no visible
   gain. This grid is the visual texture of the effect as much as a budget. */
const GAP = 4;
const PARTICLE_SIZE = 2.6;
const COLOUR_STEPS = 24;

const SPRING = 0.055;
const DAMPING = 0.86;
const PUSH_RADIUS = 108;

/* Velocity added per frame to a particle directly under the pointer, tapering
   to nothing at PUSH_RADIUS.
 *
 * The obvious inverse-square field is wrong here. It has no upper bound, so a
 * pointer resting on a glyph keeps adding force every frame until the spring
 * loses and the whole word disperses — the effect stops reading as "404" at
 * all. A bounded impulse settles instead: at equilibrium a particle sits about
 * PUSH_MAX / SPRING away from home, which is ~40px at the centre and zero at
 * the edge, so the pointer carves a hole through legible glyphs. */
const PUSH_MAX = 2.2;

// The aurora ramp, sampled left to right across the word so the glyphs carry
// the same violet → magenta → cyan travel as the rest of the product.
const RAMP = [
  [149, 92, 255],
  [255, 0, 110],
  [0, 240, 255],
];

function rampColour(t) {
  const scaled = Math.min(0.9999, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.floor(scaled);
  const f = scaled - i;
  const [r1, g1, b1] = RAMP[i];
  const [r2, g2, b2] = RAMP[i + 1];
  return `rgb(${Math.round(r1 + (r2 - r1) * f)},${Math.round(g1 + (g2 - g1) * f)},${Math.round(b1 + (b2 - b1) * f)})`;
}

export default function ParticleText({ text = '404', className = '', ratio = 0.42 }) {
  const canvasRef = useRef(null);
  const { reduced } = usePrefs();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    // No 2D context is close to impossible, but the page still has to work:
    // the heading beside this canvas already carries the message.
    if (!ctx) return undefined;

    let groups = [];
    let dims = { width: 0, height: 0 };
    let frame = 0;
    let alive = true;
    const pointer = { x: -9999, y: -9999 };

    const build = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(width * ratio));
      const dpr = Math.min(2, window.devicePixelRatio || 1);

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dims = { width, height };

      // Measure at a known size, then scale to fill the box. Doing it this way
      // means the glyphs fit whatever font actually loaded, rather than
      // whatever font we hoped had loaded.
      const probe = 100;
      const family = getComputedStyle(canvas).fontFamily || 'sans-serif';
      ctx.font = `900 ${probe}px ${family}`;
      const measured = ctx.measureText(text).width || 1;
      const size = Math.min((width * 0.92 * probe) / measured, height * 0.96);

      const sampler = document.createElement('canvas');
      sampler.width = width;
      sampler.height = height;
      const sctx = sampler.getContext('2d');
      if (!sctx) return;
      sctx.font = `900 ${size}px ${family}`;
      sctx.textAlign = 'center';
      sctx.textBaseline = 'middle';
      sctx.fillStyle = '#fff';
      sctx.fillText(text, width / 2, height / 2);

      const { data } = sctx.getImageData(0, 0, width, height);
      const buckets = Array.from({ length: COLOUR_STEPS }, (_, i) => ({
        colour: rampColour(i / (COLOUR_STEPS - 1)),
        items: [],
      }));

      for (let y = 0; y < height; y += GAP) {
        for (let x = 0; x < width; x += GAP) {
          if (data[(y * width + x) * 4 + 3] < 128) continue;
          const bucket = Math.min(COLOUR_STEPS - 1, Math.floor((x / width) * COLOUR_STEPS));
          buckets[bucket].items.push({
            hx: x,
            hy: y,
            // Entering from a scatter reads as the glyphs assembling. Starting
            // them at home instead would just be a static word that twitches.
            x: reduced ? x : x + (Math.random() - 0.5) * width * 0.7,
            y: reduced ? y : y + (Math.random() - 0.5) * height * 2.2,
            vx: 0,
            vy: 0,
          });
        }
      }
      groups = buckets.filter((b) => b.items.length);
    };

    const paint = () => {
      ctx.clearRect(0, 0, dims.width, dims.height);
      // Additive blending is what turns overlapping particles into the neon
      // bloom the palette is asking for, without drawing a single shadow.
      ctx.globalCompositeOperation = 'lighter';
      for (const group of groups) {
        ctx.fillStyle = group.colour;
        for (const p of group.items) {
          ctx.fillRect(p.x - PARTICLE_SIZE / 2, p.y - PARTICLE_SIZE / 2, PARTICLE_SIZE, PARTICLE_SIZE);
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    };

    const step = () => {
      if (!alive) return;
      for (const group of groups) {
        for (const p of group.items) {
          const dx = p.x - pointer.x;
          const dy = p.y - pointer.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < PUSH_RADIUS * PUSH_RADIUS && distSq > 0.01) {
            const dist = Math.sqrt(distSq);
            const falloff = 1 - dist / PUSH_RADIUS;
            const push = PUSH_MAX * falloff * falloff;
            p.vx += (dx / dist) * push;
            p.vy += (dy / dist) * push;
          }
          p.vx = (p.vx + (p.hx - p.x) * SPRING) * DAMPING;
          p.vy = (p.vy + (p.hy - p.y) * SPRING) * DAMPING;
          p.x += p.vx;
          p.y += p.vy;
        }
      }
      paint();
      frame = requestAnimationFrame(step);
    };

    build();

    if (reduced) {
      paint();
      // No loop and no pointer listeners at all: reduced motion means the
      // effect is not there to be provoked, not that it moves more slowly.
      const observer = new ResizeObserver(() => {
        build();
        paint();
      });
      observer.observe(canvas);
      return () => {
        alive = false;
        observer.disconnect();
      };
    }

    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
    };
    const onLeave = () => {
      pointer.x = -9999;
      pointer.y = -9999;
    };

    // Bound to the canvas, not to window. An element listener dies with the
    // element, so there is no way to be called after unmount holding a stale
    // ref — a failure this codebase has already paid for once, in DotGrid.
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);

    const observer = new ResizeObserver(build);
    observer.observe(canvas);
    frame = requestAnimationFrame(step);

    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, [text, ratio, reduced]);

  return <canvas ref={canvasRef} className={`particle-text ${className}`} aria-hidden="true" />;
}
