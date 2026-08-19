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
| `Stepper.jsx` | Added `canProceed(step)` and `advanceOnComplete` | Its step indicators called `updateStep(clicked)` for any step, so they were free jump targets — you could click straight to the last step and submit with nothing filled in, and disabling the Continue button did nothing about it. Separately, completing always advanced past the last step into a state that renders neither content nor a footer, which strands the user whenever the callback does not navigate away. |

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

## LogoLoop — `overflow: hidden` on `.logoloop`

The marquee track duplicates its content to loop seamlessly, so it is several
screens wide by design. Unclipped, that width becomes the *document's* width:
measured at 4,883px on a 360px phone, which made the whole landing page
rubber-band sideways. The wrapper now clips it.

## ElectricBorder — `overflow: hidden` on `.eb-canvas-container`

The filter canvas is drawn larger than the card it borders, because the
displacement effect needs bleed to avoid a hard edge. On a narrow screen that
bleed escaped the card and pushed the document 42px past the viewport. The
container clips it; the canvas itself is untouched, since clamping the canvas
is what once collapsed the border into two vertical lines.
