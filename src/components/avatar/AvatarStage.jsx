import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Spinner } from '../ui.jsx';
import AvatarModel from './AvatarModel.jsx';
import ThoughtBubble from './ThoughtBubble.jsx';
import { thoughtFor } from './thoughts.js';

/**
 * The three.js canvas for the avatar. Loaded lazily by `AvatarShowcase`, which
 * owns the decision about whether to load it at all — everything in this file
 * is only ever reached once that decision is yes.
 */
export default function AvatarStage({ url, thoughts = true }) {
  const [ready, setReady] = useState(false);
  const [clip, setClip] = useState(null);
  const mounted = useRef(true);

  // Both halves matter. StrictMode runs effects mount → cleanup → mount in
  // development, so a cleanup-only version latched `mounted` to false on the
  // first teardown and never set it back — `onReady` then fired into a guard
  // that could never pass, and the model stayed hidden behind its spinner with
  // a fully measured mesh sitting right there. Setting it true on every mount
  // is what makes the guard mean "is mounted" rather than "has ever unmounted".
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onClip = useCallback((index) => setClip(index), []);

  return (
    <div className={`avatar-stage ${ready ? 'is-ready' : ''}`}>
      {thoughts && ready && clip !== null && (
        <ThoughtBubble text={thoughtFor(clip)} side={clip % 2 === 0 ? 'left' : 'right'} />
      )}
      {/* The model is large, and the canvas element exists long before there is
          anything in it. Without this the frame is simply blank for as long as
          the download takes, which reads as broken rather than as loading. */}
      {!ready && (
        <div className="avatar-loading" role="status">
          <Spinner size={22} />
          <span>Loading the model…</span>
        </div>
      )}
      <Canvas
        camera={{ position: [0, 0.15, 2.9], fov: 34 }}
        // Capped so a high-DPI laptop does not render this at 3x while a
        // projector shows it at 1x anyway.
        dpr={[1, 1.6]}
        // Deliberately NOT `frameloop="demand"`. That stops useFrame entirely,
        // and the model measures and frames itself in useFrame — a canvas that
        // mounted while out of view then never measured, never called onReady,
        // and sat invisible behind a spinner with a fully-loaded model inside.
        frameloop="always"
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      >
        <ambientLight intensity={0.7} />
        {/* Violet key from the left, cyan rim from the right — the two ends of
            the product's own ramp, so the figure is lit by the palette rather
            than by neutral studio light. */}
        <directionalLight position={[-2.4, 2.2, 2.6]} intensity={2.1} color="#a982ff" />
        <directionalLight position={[2.8, 1.2, -1.6]} intensity={1.5} color="#00f0ff" />
        <directionalLight position={[0, -1.5, 1.8]} intensity={0.5} color="#ff006e" />
        {/* No <Environment preset>. drei fetches that HDRI from a CDN, and it
            suspends this same boundary — so with no network the model never
            rendered at all and the frame stayed on its spinner with a
            fully-loaded model behind it. It is also precisely the offline
            dependency the rest of this app avoids: the demo has to survive
            conference wifi. Three directional lights do the job. */}
        <Suspense fallback={null}>
          <AvatarModel url={url} onClip={onClip} onReady={() => mounted.current && setReady(true)} />
        </Suspense>

        {/* Rotate only. Pan and zoom inside a scrolling page fight the scroll,
            and on a touchscreen a zoomable canvas swallows the gesture that
            gets you past it. */}
        <OrbitControls
          makeDefault
          enablePan={false}
          enableZoom={false}
          minPolarAngle={Math.PI / 2.6}
          maxPolarAngle={Math.PI / 1.9}
          rotateSpeed={0.7}
        />
      </Canvas>
    </div>
  );
}
