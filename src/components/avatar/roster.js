import { THOUGHTS } from './thoughts.js';

/**
 * The people on the "Built by" carousel, in the order they are shown.
 *
 * A list rather than hardcoded slides because everything downstream — the dots,
 * the arrows, the keyboard handler, the caption — is driven by its length.
 * Adding someone is a `.glb` in `public/models/` and an entry here.
 *
 * `animated` is not cosmetic. Richie's export carries seven NLA clips, so the
 * figure idles on its own and its thought bubble follows whichever clip is
 * playing. The three Meshy exports are single static meshes with no skin and no
 * clips at all, so nothing would ever move and nothing would ever change the
 * thought. Those slides get a slow turntable and a timer instead, which is the
 * difference between "a model" and "a photograph of a model".
 */

const url = (file) => `${import.meta.env.BASE_URL}models/${file}`;

export const AVATARS = [
  {
    id: 'richie',
    name: 'Richie Koh',
    url: url('avatar.glb'),
    animated: true,
    thoughts: THOUGHTS,
  },
  {
    id: 'rihan',
    name: 'Rihan Iqbal',
    url: url('rihan.glb'),
    animated: false,
    thoughts: [
      'If the summary cannot point at the slide, it does not ship.',
      'Every citation on this site resolves to a page number.',
      'Ninety-nine thousand triangles, and it still loads on hall wifi.',
    ],
  },
  {
    id: 'hongyi',
    name: 'Hong Yi',
    url: url('hongyi.glb'),
    animated: false,
    thoughts: [
      'Read the deck twice. Still could not have told you the answer.',
      'A summary you cannot check is just a rumour about your notes.',
      'Three weeks of lectures, one evening, one recap.',
    ],
  },
  {
    id: 'dillon',
    name: 'Dillon Poh',
    url: url('dillon.glb'),
    animated: false,
    thoughts: [
      'Quiz me on it. That is the only test that counts.',
      'Got it wrong, saw the slide, got it right. That is the loop.',
      'Studying is not re-reading. It took a hackathon to learn that.',
    ],
  },
];
