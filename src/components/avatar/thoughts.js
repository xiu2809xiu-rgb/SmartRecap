/**
 * One thought per animation clip.
 *
 * The clips are exported from Blender NLA tracks and are all called
 * `NlaTrack.00N`, so their names say nothing about what they show. Rather than
 * guess — and risk captioning a stretch with "just finished a quiz" — each was
 * characterised from the animation data itself: total angular movement summed
 * across every rotation track, grouped by which part of the body it belongs to.
 *
 *   clip  length  movement  dominant regions
 *   0     4.8s      154°    arms 50, legs 30   — almost perfectly still
 *   1     4.3s     2760°    arms 55, legs 37   — brisk, whole body
 *   2    11.0s     7191°    arms 57, legs 24   — by far the largest motion
 *   3     5.7s     1077°    arms 65, legs 18, head 10
 *   4     3.2s     1144°    arms 77            — short, arm-led gesture
 *   5    12.5s     2272°    legs 41, arms 36   — the only leg-led clip
 *   6    10.9s     2322°    arms 92            — sustained, almost pure arms
 *
 * So the thoughts are matched to energy and body region, which is what is
 * actually observable, rather than to an invented name for the motion. The
 * order here is the order the clips play in.
 */

export const THOUGHTS = [
  // 0 — barely moves. Stillness reads as concentration.
  'Okay. Read it once more, properly this time.',

  // 1 — brisk whole-body movement. Restlessness after sitting too long.
  'Third hour on this deck. My legs have opinions.',

  // 2 — the biggest motion in the set, and long. Only one thing this can be.
  'Twelve out of twelve. On the first try.',

  // 3 — moderate, and the only clip with meaningful head movement.
  'Hold on — which slide was that on?',

  // 4 — short and arm-led. A gesture outward, at someone or something.
  'Right, your turn. Quiz me.',

  // 5 — the only leg-led clip, and the longest. Pacing while thinking.
  'I can only tell I understand it once I can say it out loud.',

  // 6 — sustained, almost entirely arms. Stretching at a desk.
  'Been sitting since two. Stretch, then the last topic.',
];

/* Indexed by the caller — AvatarStage wraps on length, so clips can be added to
   the model without this list having to keep up. */
