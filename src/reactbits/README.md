# Vendored React Bits components

Source: [React Bits](https://reactbits.dev) by David Haz — <https://github.com/DavidHDev/react-bits>
Licence: MIT + Commons Clause (free for personal and commercial use; you may not
sell the component library itself).

React Bits is a copy-and-own library rather than an npm dependency: you take the
source into your project and it becomes yours to modify. These are the JS + CSS
variants, matching this project's stack (plain JavaScript, no Tailwind).

## What was changed

Everything in this folder is the upstream source except where noted. Changes are
marked with a `SmartRecap change:` comment at the edit site.

| File | Change | Why |
|---|---|---|
| `MagicBento.jsx` | Added a `cards` prop, falling back to the bundled `cardData` | The component hard-codes its own demo copy. Our feature grid has to supply its own. |
| `ScrollFloat.jsx` | Spaces are emitted as bare text nodes rather than ` ` inside a `.char` span | A non-breaking space carried onto the next line renders a visible indent on any heading that wraps. gsap only ever targets `.char`, which spaces never needed to be. |
| `DotGrid.jsx` | Null guard at the top of its `onClick` | The handler is bound to `window`, so it also fires for clicks that unmount the grid — every link click in the app shell. By the time it ran the canvas ref was already null, throwing an uncaught TypeError on each navigation. |

Everything else is themed from CSS in `src/styles/app.css` and the page
stylesheets rather than by editing component source, so upstream updates can be
dropped in with minimal reconciliation. The non-obvious ones are commented where
the override lives — `GooeyNav`'s blend-mode backdrop and `Stepper`'s fixed
aspect ratio in particular.

## Not vendored, and why

Some components were left out because their dependencies are not worth the
bundle for one screen: `ScrollStack` (lenis), `ElasticSlider` (@chakra-ui/react),
`InfiniteMenu` (gl-matrix), `DomeGallery` (@use-gesture/react) and `Lanyard`
(@react-three/rapier + meshline). Add the dependency and copy the file in if a
screen ever needs one.

`ModelViewer.jsx` is vendored but not used directly — `src/mascot/MascotModel.jsx`
is derived from it, keeping the bounding-sphere normalisation and adding
animation-clip playback, which the original does not do.
