/**
 * Rec's state machine.
 *
 * Rec is not decoration. Every state below is bound to something the app is
 * actually doing, which is what earns a 3D character a place in a study tool:
 * during the 20-40 seconds the pipeline is running, the mascot IS the progress
 * indicator, and it tells you which stage you are in without you reading a log.
 *
 * `clip` is the exact animation-clip name expected inside `rec.glb`. If you
 * export clips with these names, the model plugs straight in; anything missing
 * falls back to `Idle`, and if the whole model is missing the procedural Rec
 * renders the same states in code. See docs/MASCOT-BRIEF.md.
 */

export const MASCOT_STATES = {
  idle: {
    clip: 'Idle',
    loop: true,
    caption: 'Ready when you are.',
    /** Procedural fallback parameters — how code-Rec behaves without a GLB. */
    proc: { bob: 1, spin: 0.15, tilt: 0, eye: 1, ringSpeed: 0.4, handLift: 0, hue: 0 },
  },
  reading: {
    clip: 'Reading',
    loop: true,
    caption: 'Reading your slides.',
    proc: { bob: 0.6, spin: 0, tilt: 0.42, eye: 0.55, ringSpeed: 1.1, handLift: -0.1, hue: 0.5, scan: true },
  },
  thinking: {
    clip: 'Thinking',
    loop: true,
    caption: 'Working out what matters.',
    proc: { bob: 0.45, spin: 0, tilt: -0.14, eye: 0.4, ringSpeed: 3.2, handLift: 0.22, hue: 1, orbit: true },
  },
  celebrate: {
    clip: 'Celebrate',
    loop: false,
    caption: 'Strong round.',
    proc: { bob: 2.2, spin: 2.4, tilt: -0.2, eye: 1.3, ringSpeed: 4.5, handLift: 0.5, hue: 0.8, burst: true },
  },
  encourage: {
    clip: 'Encourage',
    loop: false,
    caption: 'Worth another pass.',
    proc: { bob: 0.9, spin: 0, tilt: 0.1, eye: 0.9, ringSpeed: 0.7, handLift: 0.12, hue: 0.3, nod: true },
  },
  wave: {
    clip: 'Wave',
    loop: false,
    caption: 'Upload something to get started.',
    proc: { bob: 1.1, spin: 0, tilt: 0, eye: 1.1, ringSpeed: 0.6, handLift: 0.34, hue: 0.2, wave: true },
  },
  confused: {
    clip: 'Confused',
    loop: true,
    caption: 'That did not go through.',
    proc: { bob: 0.5, spin: -0.5, tilt: 0.24, eye: 0.5, ringSpeed: 0.2, handLift: 0.05, hue: 1.4, wobble: true },
  },
};

export const DEFAULT_STATE = 'idle';

/** Maps a pipeline stage id onto the state Rec should be in. */
export const STAGE_STATE = {
  upload: 'idle',
  extract: 'reading',
  chunk: 'reading',
  recap: 'thinking',
  quiz: 'thinking',
  ground: 'thinking',
  translate: 'thinking',
  store: 'idle',
  done: 'celebrate',
};

export const resolveState = (name) => MASCOT_STATES[name] ?? MASCOT_STATES[DEFAULT_STATE];
