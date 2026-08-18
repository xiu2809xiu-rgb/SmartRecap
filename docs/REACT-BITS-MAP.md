# React Bits — what is used where, and why

39 components are vendored under `src/reactbits/`. This is where each one earns
its place, because "we used a component library" is not a feature and a judge
can tell the difference between a page that uses effects and a page that is
made of them.

Three rules governed the choices:

1. **One WebGL backdrop per route.** Three live shader canvases on one screen is
   three GPU contexts. Sections layer CSS gradients on top of the one backdrop.
2. **Everything heavy comes off under reduced motion.** Not slowed — removed. A
   paused shader still holds a GPU context.
3. **A component that fights the design gets cut.** Two did. See the bottom.

---

## Landing (`/`)

| Component | Where | Why this one |
|---|---|---|
| `Aurora` | Fixed backdrop | The anchor's mesh gradient is the primary surface feature, and Aurora is the cheapest of the shader backgrounds that produces one (202 lines, ogl) |
| `SplitText` | Hero headline | Per-character entrance is the one place oversized display type earns an animation |
| `ShinyText` | Hero eyebrow | A moving highlight on four words, where a static label would be dead space |
| `BlurText` | Hero lede | Word-by-word arrival paces a long paragraph so it is not a wall on first paint |
| `CountUp` | Hero stat strip | Three real numbers from the sample deck — counting them up is the reason to look |
| `Magnet` | Primary CTA | Pulls toward the cursor. The single most-clicked element on the page |
| `StarBorder` | Secondary CTA | Distinguishes it from the primary without a second gradient competing |
| `ScrollFloat` | "How it works" heading | Per-character reveal tied to scroll, not to load |
| `AnimatedContent` | The three steps | Staggered entry as each scrolls in |
| `CardSwap` | "How it works" visual | An auto-rotating 3D stack of the same three steps — the copy and the visual say the same thing two ways |
| `FadeContent` | Grounding demo | Blur-in on the live reader panel |
| `GradientText` | Grounding + CTA headings | The animated ramp the hero cannot use, because gsap splitting a line into per-character spans breaks `background-clip: text` |
| `SpotlightCard` | Three grounding cards | Cursor-tracking highlight, cheap, no canvas |
| `MagicBento` | Feature grid | The showpiece. Spotlight, particles and tilt on a real bento layout |
| `LogoLoop` | "Built on" marquee | Ten services and libraries, scrolling, pause on hover |
| `Threads` | CTA band backdrop | A second shader, but on its own section far below the hero — never both in view |

## Auth (`/login`, `/signup`)

| Component | Where | Why |
|---|---|---|
| `Aurora` | Backdrop at 60% opacity | Same ground as the landing page, quieter — the form is the subject |
| `ElectricBorder` | Form card | Animated border that says "this is the live thing on the page" without adding a colour |
| `BlurText` | Card heading | Consistent with the landing hero |

## App shell

| Component | Where | Why |
|---|---|---|
| `GooeyNav` | Marketing top nav | Hash links to page sections, which is exactly the anchor-based navigation it is built for |
| `DotGrid` | App backdrop, quiet | Interactive but nearly invisible — texture behind a working surface, not a feature |
| `ClickSpark` | Global | Click feedback everywhere at once, one component at the router root |

## Library (`/app`)

| Component | Where | Why |
|---|---|---|
| `SpotlightCard` | Material cards | Cursor highlight on a grid of cards is what it is for |
| `CountUp` | Four stat tiles | Streak, materials, average score, minutes saved |
| `AnimatedContent` | Resume card and the grid | Staggered entry, capped at 0.3s so a long library does not crawl in |

## Upload (`/app/upload`)

| Component | Where | Why |
|---|---|---|
| `Stepper` | The three-step wizard | File → depth → details. Its default 2:1 aspect ratio and 28rem cap are released in CSS so it fills the panel |

## Processing (`/app/processing/:jobId`)

| Component | Where | Why |
|---|---|---|
| `Threads` | Backdrop | Flowing lines under a screen that is about work happening |
| `DecryptedText` | Stage label | Resolves character by character on every stage change, so the label change is impossible to miss |
| `CountUp` | Progress percentage | Re-keyed every 10% so it counts up in steps rather than jittering |

## Recap reader (`/app/material/:id`)

Deliberately the sparsest page in the app. This is the light study surface and
the point is reading.

| Component | Where | Why |
|---|---|---|
| `FadeContent` | Summary card only | One entrance, then the page gets out of the way |

The citation ribbon here is hand-built (`src/components/Citations.jsx`) — no
React Bits component draws a bezier between two arbitrary DOM nodes.

## Quiz, results, flashcards, progress

| Component | Where | Why |
|---|---|---|
| `BlurText` | Question prompt | Word-by-word arrival, and it makes the question change legible between items |
| `CountUp` | Results score, progress stats | Real numbers worth animating |
| `AnimatedContent` | Progress cards | Staggered entry on four analytics panels |

Charts are hand-built SVG (`src/components/charts/Charts.jsx`) against a palette
validated with the data-viz validator on both surfaces — a component library is
the wrong tool for a chart that has to pass a contrast and colourblindness check.

---

## Cut, and why

**`Dock`** — a floating quick-action bar at the bottom centre of the app shell.
It duplicated the top nav, and being fixed it sat on top of the library search
field and the upload wizard's Continue button. A redundant floating element
covering a primary action is a UX regression regardless of how good it looks.

**`Lanyard`, `ScrollStack`, `ElasticSlider`, `InfiniteMenu`, `DomeGallery`** —
not vendored. Each needs a dependency (rapier + meshline, lenis, chakra-ui,
gl-matrix, use-gesture) that is not worth the bundle for one screen.

---

## Fixes applied

React Bits is copy-and-own, and several components assume a host that is not
this one. Each fix is commented at the override site.

| Component | Problem | Fix |
|---|---|---|
| `GooeyNav` | Its blob is a black rectangle blended with `mix-blend-mode: lighten`, which only vanishes against an opaque darker backdrop in its own stacking context. Over a transparent topbar it rendered as a black box, and its `inset: -75px` bleed spilled past the nav. Separately, the effect layer repaints the active label sized to the link's box — inheriting a different font size or weight from the link made the label render doubled a few pixels apart | `isolation` + a solid pill + `overflow: hidden`, and the type scale moved onto the shared container |
| `SplitText` | gsap splits a line into per-character spans, so a `background-clip: text` gradient on the parent cannot survive — each span would carry its own copy of the ramp. Its inline `display: inline-block` also made two adjacent instances reflow as one paragraph | Accent line switched to a flat neon colour with the anchor's glow; each instance wrapped in its own block |
| `ScrollFloat` | Emits spaces as ` ` inside a `.char` span, so a heading that wraps carries the space onto the next line as a visible indent | Patched to emit bare text nodes for spaces (gsap only targets `.char`) |
| `MagicBento` | Hard-codes its own demo copy, and clamps descriptions to two lines | Added a `cards` prop; `textAutoHide={false}` |
| `Stepper` | Built as a standalone centred widget — 2:1 aspect ratio above 768px, card capped at 28rem — so it rendered as a narrow slab overflowing its container | Both released in CSS |
| `LogoLoop` | `fadeOut` paints a solid colour at the marquee edges, which over a live aurora reads as two dark bands | Replaced with a real transparent `mask-image` |
| `StarBorder` | Ships a black inner pill for light pages | Rebound to the glass surface |

The full list of source edits (only two components needed one) is in
`src/reactbits/README.md`.
