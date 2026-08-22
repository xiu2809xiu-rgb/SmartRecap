import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Spinner } from '../ui.jsx';
import AvatarModel from './AvatarModel.jsx';
import ThoughtBubble from './ThoughtBubble.jsx';
import { THOUGHTS } from './thoughts.js';

/**
 * The three.js canvas for the avatar. Loaded lazily by `AvatarShowcase`, which
 * owns the decision about whether to load it at all — everything in this file
 * is only ever reached once that decision is yes.
 *
 * ONE canvas, whatever `url` is. The carousel changes the prop rather than
 * mounting a stage per person, because a WebGL context is a scarce, expensive
 * thing — browsers cap them somewhere around eight to sixteen per page, and
 * this page already spends some on the aurora backdrop and the mascot. Four
 * team members meant four contexts, and the failure mode when you run out is
 * not a slow page, it is the oldest canvas going black. Swapping the model
 * inside a single context also makes going back instant: drei's `useGLTF`
 * caches the parsed scene by URL, so a model you have already seen re-mounts
 * with no fetch and no parse.
 */
export default function AvatarStage({ url, thoughts = THOUGHTS, animated = true, spin = false }) {
  // Which URL has finished measuring, rather than a boolean.
  //
  // A boolean `ready` would stay true through a model swap: the spinner would
  // vanish, `is-ready` would hold the stage at full opacity, and the frame
  // would show the *previous* person until the new mesh happened to appear.
  // Comparing against the URL means changing person resets the reveal for free,
  // in render, with no effect and no one-frame flash of the wrong figure.
  const [loaded, setLoaded] = useState(null);
  const ready = loaded === url;

  const [clip, setClip] = useState(null);
  const mounted = useRef(true);

  // A static export never fires `onClip`, so `clip` stays null forever and the
  // clip-driven bubble would simply never appear. For those models the thought
  // advances on a timer instead. Deliberately longer than the bubble's own 4.2s
  // hold, so there is a beat of quiet between thoughts rather than one sentence
  // cutting into the next.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (animated || !ready || thoughts.length < 2) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 6200);
    return () => clearInterval(id);
  }, [animated, ready, thoughts.length]);

  // Start each person on their first thought. Without this, arriving at the
  // fourth slide with the timer already at 7 would open on a line from the
  // middle of their set, which reads as having missed the beginning.
  useEffect(() => {
    setTick(0);
    setClip(null);
  }, [url]);

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

  // Which thought is showing, and which side of the figure it sits on. For an
  // animated model that is the running clip; for a static one it is the timer.
  // Both alternate sides so consecutive thoughts never stack in one corner.
  const beat = animated ? clip : tick;
  const line = thoughts.length && beat !== null ? thoughts[beat % thoughts.length] : null;

  return (
    <div className={`avatar-stage ${ready ? 'is-ready' : ''} ${animated ? '' : 'is-static'}`}>
      {ready && line && <ThoughtBubble text={line} side={beat % 2 === 0 ? 'left' : 'right'} />}
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
          {/* Keyed on the URL so a new person is a fresh mount rather than a
              re-render. The framing pass in AvatarModel latches once it is
              happy and then never measures again, so without the key a swapped
              model would inherit the previous figure's scale and offset —
              someone tall wearing someone short's framing. */}
          <AvatarModel
            key={url}
            url={url}
            onClip={onClip}
            onReady={() => mounted.current && setLoaded(url)}
          />
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
          // Only for the models that hold still on their own. A turntable under
          // an idling figure fights the animation; under a static mesh it is
          // the only thing that stops the slide reading as a still image.
          // `autoRotate` yields to a drag and resumes after it, which is why it
          // is set here rather than animated on the group.
          autoRotate={spin}
          autoRotateSpeed={0.6}
        />
      </Canvas>
    </div>
  );
}
