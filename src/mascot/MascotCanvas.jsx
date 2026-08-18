import { Suspense, lazy } from 'react';
import { Canvas } from '@react-three/fiber';
import { ContactShadows } from '@react-three/drei';
import ProceduralRec from './ProceduralRec.jsx';

const MascotModel = lazy(() => import('./MascotModel.jsx'));

/**
 * The WebGL half of Rec, split into its own chunk.
 *
 * Everything three.js touches lives below this file so that importing `Mascot`
 * — which most pages do — does not drag the renderer into the entry bundle.
 * `Mascot.jsx` lazy-loads this and shows the flat badge until it arrives.
 */
export default function MascotCanvas({ url, state, intensity = 1, shadow = true }) {
  return (
    <Canvas
      dpr={[1, 1.75]}
      shadows={shadow}
      /* Framed with slack on all sides: the orbit ring sits well above the
         body, and a tighter camera clips it against the canvas edge. */
      camera={{ fov: 34, position: [0, 0.12, 2.95], near: 0.1, far: 20 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
    >
      {/* Explicit lights rather than drei's Environment presets: those fetch an
          HDR from a CDN, which a strict CSP or an offline demo would block. */}
      <ambientLight intensity={0.55 * intensity} />
      <directionalLight position={[2.6, 3.2, 2.4]} intensity={2.1 * intensity} castShadow />
      <directionalLight position={[-3, 1.2, 1.5]} intensity={0.7 * intensity} color="#ff006e" />
      <directionalLight position={[0, 1.4, -3]} intensity={1.5 * intensity} color="#00f0ff" />
      <pointLight position={[0, -1, 1.2]} intensity={0.5 * intensity} color="#a78bfa" />

      <Suspense fallback={<ProceduralRec state={state} />}>
        {url ? <MascotModel url={url} state={state} /> : <ProceduralRec state={state} />}
      </Suspense>

      {shadow && <ContactShadows position={[0, -0.62, 0]} opacity={0.42} scale={3.4} blur={2.6} far={1.4} />}
    </Canvas>
  );
}
