import { lazy, Suspense } from 'react';
import { usePrefs } from '../lib/prefs.jsx';

/**
 * The mesh-gradient ground.
 *
 * Aurora Maximalism treats the gradient as the primary surface feature rather
 * than decoration, so it is present on every dark screen — but it is a live
 * WebGL canvas, and three of them on one route is three GPU contexts. Rules:
 *
 *  - One backdrop per route. Sections layer CSS gradients on top, not shaders.
 *  - `prefers-reduced-motion` (or the preference toggle) drops to a static CSS
 *    mesh that is visually close and costs nothing.
 *  - Every shader is lazy so it stays out of the initial bundle.
 *
 * Variants map to React Bits background components; see docs/REACT-BITS-MAP.md.
 */

const Aurora = lazy(() => import('../reactbits/Aurora.jsx'));
const Threads = lazy(() => import('../reactbits/Threads.jsx'));
const Particles = lazy(() => import('../reactbits/Particles.jsx'));
const DotGrid = lazy(() => import('../reactbits/DotGrid.jsx'));

const AURORA_STOPS = ['#5D34D0', '#FF006E', '#00F0FF'];

export default function AuroraBackdrop({ variant = 'aurora', className = '', opacity, children }) {
  const { allowEffects } = usePrefs();

  return (
    <div className={`backdrop backdrop-${variant} ${className}`} aria-hidden="true">
      <div className="backdrop-static" />
      {allowEffects && (
        <div className="backdrop-live" style={opacity != null ? { opacity } : undefined}>
          <Suspense fallback={null}>
            {variant === 'aurora' && <Aurora colorStops={AURORA_STOPS} amplitude={1.15} blend={0.62} speed={0.7} />}
            {variant === 'threads' && <Threads color={[0.65, 0.44, 1]} amplitude={1.4} distance={0.35} />}
            {variant === 'particles' && (
              <Particles
                className=""
                particleCount={140}
                particleColors={AURORA_STOPS}
                particleSpread={13}
                speed={0.08}
                particleBaseSize={70}
                alphaParticles
                moveParticlesOnHover
                particleHoverFactor={0.6}
                cameraDistance={22}
              />
            )}
            {variant === 'dotgrid' && (
              <DotGrid className="" dotSize={3} gap={26} baseColor="#2a1b4d" activeColor="#a78bfa" proximity={130} shockRadius={190} />
            )}
          </Suspense>
        </div>
      )}
      {children}
    </div>
  );
}
