# vr-juggling-tools
pattern visualization, picture in picture, suite of innovative tools

## VR juggling visualizer: see the ideal pattern (version 1)

One web page that shows how a juggling pattern looks when it is juggled the optimal way, using
Jack Kalvan's optimal-juggling math and real gravity. Put on a VR headset and stand in the
juggler's spot, or open the same page on a laptop or phone.

Planned address: https://www.grahampaasch.com/juggling/vr (it is not deployed yet, see
[Deploying](#deploying)).

The spec this was built from is `specs/35-vr-juggling-visualizer.md` in the voice-ui repo.

### What version 1 does

- **Patterns.** Any vanilla (alternating hands, one ball per throw) siteswap: `3`, `531`, `441`,
  `456`, `97531`. Presets for the 3, 4, 5, 6 and 7 ball cascades and fountains. Balls only.
  Synchronous and multiplex siteswaps are refused with a message that says why.
- **Physics is the math, only.** Exact flight time and height for every throw value from the beat
  time, the dwell and g = 9.81 m/s². Nothing on the page lets you drag a height or change gravity.
- **Kalvan's spatial optimum** for uniform cascades and fountains. For any other siteswap: exact
  timing and heights on a standard layout, and a warning (with red rings in the scene) if balls
  would collide. The page says which case you are looking at.
- **Tempo.** Always opens at real speed. Slow motion slows the clock and nothing else. Any speed
  other than 1x keeps a label such as `0.5x` on screen (head-locked in VR).
- **View.** Starts in the juggler's spot, first person. In VR you walk around the pattern (or move
  with the left stick, turn with the right stick). On a flat screen "Step out" orbits it.
- **Calibration.** Hold the controllers where you naturally catch and pull a trigger: that records
  hand height and distance from the body, and the pattern is built there. Sliders (and plus/minus
  buttons in VR) fine-tune both.
- **Hands.** Ghost hands do the correct scoop: catch outside, carry in and under, release inside,
  return over the top, hands alternating. Your own hands are drawn at the controllers so you can
  line them up with the ghosts. Hand tracking is an optional toggle. There is no scoring.
- **Palm, not controller tip.** A ball lands at the WebXR grip pose, which is defined as the centre
  of the curled fingers. A "palm ball" mode rests a ball in each hand and three nudges move the
  landing point until it feels like your real palm.
- **Sound.** Catch (a ball landing in a palm), release (the ball leaving the hand, a little
  quieter by default) and a peak tone at the exact top of each arc whose pitch follows the height.
  Each has its own volume, mute and solo.

### Run it

```
npm run serve                 # http://localhost:8080, no build step and no dependencies
npm test                      # unit tests (node --test), no dependencies
npm install && npm run smoke  # headless Chromium, flat screen and an emulated Quest 1
```

WebXR only works on https or on localhost. To try a local copy in the headset before it is
deployed, connect it by USB and run `adb reverse tcp:8080 tcp:8080`, then open
`http://localhost:8080` in the headset browser. A plain `http://192.168...` link will not offer VR.

Useful addresses: `?s=531` opens a pattern, `?view=orbit` starts stepped out.

In VR: **A or X** shows or hides the control board; point at a button and pull the trigger.

## The math

Everything here lives in `src/physics.js`, which has no dependencies and is covered by
`test/physics.test.js`.

### 1. Shannon's theorem

For uniform juggling, with `h` hands, `n` balls, dwell time `d` (catch to throw), flight time `f`
and empty time `e` (throw to next catch) [S]:

    h (d + f) = n (d + e)

Kalvan [K96] rewrites it with the hand period `T = d + e`, the dwell ratio `r = d / T` and
`W = f / T`, the average number of balls in flight per hand:

    n / h = W + r        so        W = n/2 - r    and    f = W T

### 2. Timing for any siteswap

A throw of value `v` made on beat `i` is thrown again on beat `i + v`, and is caught one dwell
time before that. With beat time `B` (two hands alternate, so `T = 2B`) and dwell `d = r T`:

    f(v) = v B - d = (v - 2r) B            flight time, v >= 3
    H(v) = g f(v)² / 8                     height above the hands, g = 9.81 m/s²

For a uniform pattern, `v = n`, this is exactly Shannon's `f = (n/2 - r) T`. `H = g f²/8` is
[K96]: a ball thrown and caught at the same height rises for `f/2`. Doubling the flight time
quadruples the height.

Slow motion multiplies the clock that reads these formulas. `g`, `f` and `H` never change.

### 3. Kalvan's spatial optimum (uniform cascades and fountains)

Kalvan calls a pattern spatially optimal when it leaves the same room for error at every place
balls can collide: "a chain is only as strong as its weakest link" [K96]. Two places matter.

**Same arc.** Neighbours on one arc are `1/W` of the flight apart, so their closest approach is
horizontal and equal to [K96, "optimal arc"]:

    D1 = F / W                              F = flight distance (throw point to catch point)

**Opposite arcs of a cascade.** Seen from one ball, a ball on the other arc moves in a straight
line (both fall with the same g): horizontally at `2 Vh`, vertically at `g T / 2`, because they
were thrown `T/2` apart. Their closest approach `D2` and the distance `P` between the two arcs
satisfy [K96; KL18 p. 149]:

    (P / D2)² = (4 Vh / (g T))² + 1         Vh = F / f

Setting `D2 = D1` gives the optimal `P`. The two catch points are then `F + P` apart; each hand
catches outside at `x = (F + P)/2` and throws inside at `x = (F - P)/2`.

**Room for error** [KL18, as quoted in juggling_coach]:

    Emax = (D1 - D) / (4 H)                 radians; D = ball diameter

An angle error `e` moves a ball sideways `2 H e` at the top of its arc; two neighbours erring
toward each other close the gap `D1 - D` at `4 H e`.

**Fountains** [K96]: each ball returns to the hand that threw it, so the hand travels the full
flight distance, `E = F = W D1`, and `H = g (T W)² / 8`.

**What the juggler chooses.** Kalvan treats the tempo `T`, the dwell ratio `r` and the amount of
room for error (set by `F`) as the juggler's preference, and derives the rest. This app takes
`T` and `F` from his published numbers and uses `r = 0.7` and `D = 6 cm` throughout:

| Balls | Pattern | T (s) | F (m) | Source |
|---|---|---|---|---|
| 3 | cascade | 0.55 | 0.33 (and P = 0.20) | [K96] measured, Kalvan |
| 4 | fountain | 0.53 | 0.25 | [K96] measured, Kalvan |
| 5 | cascade | 0.49 | 0.52 | [KL18] table of good patterns |
| 6 | fountain | 0.47 | 0.38 | [K96] measured, Kalvan |
| 7 | cascade | 0.42 | 0.65 | [KL18] table = juggling_coach README |
| 8 | fountain | 0.38 | 0.44 | [K96] measured, Anthony Gatto |
| 9, 11, 13 | cascade | 0.35, 0.30, 0.27 | 0.73, 0.80, 0.93 | [KL18] table of good patterns |

**Check against the published table.** From only `T`, `F`, `r = 0.7` and `D = 6 cm`, the formulas
above give (published values in brackets):

| Balls | W | H (m) | D1 (m) | P (m) | Width (m) | Emax (deg) |
|---|---|---|---|---|---|---|
| 5 | 1.8 | 0.95 [1.0] | 0.289 [.29] | 0.322 [.32] | 0.842 [.84] | 3.44 [3.3] |
| **7** | **2.8** | **1.70 [1.7]** | **0.232 [.23]** | **0.263 [.27]** | **0.913 [.92]** | **1.45 [1.4]** |
| 9 | 3.8 | 2.17 [2.2] | 0.192 [.19] | 0.228 [.23] | 0.958 [.96] | 0.87 [.84] |
| 11 | 4.8 | 2.54 [2.6] | 0.167 [.17] | 0.209 [.22] | 1.009 [1.02] | 0.60 [.60] |
| 13 | 5.8 | 3.01 [3.0] | 0.160 [.16] | 0.215 [.22] | 1.145 | 0.48 |

The 7-ball row is the one in the juggling_coach README (T = .42 s, W = 2.8, H = 1.7 m, F = .65 m,
D1 = .23 m, P = .27 m, width .92 m, Emax 1.4°). Every value is reproduced to within about a
centimetre and a tenth of a degree. The small differences are rounding in the printed table: for
example its Emax is computed from its own rounded D1 and H, (0.23 - 0.06) / (4 x 1.7) = 1.43°.
The unit tests pin these tolerances.

The collision detector (next section) independently finds a closest approach of exactly `D1` in
every one of these cascades, which checks both the formula for `P` and the detector.

### 4. Collision check (all patterns)

Two balls in flight share the same acceleration, so their separation changes linearly with time.
The closest approach of every pair of flights is therefore found exactly, with no time stepping.
Centres closer than one ball diameter count as a collision. `456` on the standard layout is a real
one: a 5 at its peak meets a rising 6, 4.6 cm between centres. That is the pattern the spec
suggests fixing with an outside throw in version 2.

Scope: balls in flight, in the ideal planar pattern. Balls being carried by a hand are not checked.

## What is exact and what is assumed

Exact, straight from the formulas above: flight time and height of every throw; when and where
every catch and release happens; which hand throws; the hand's velocity at release; `W`, `D1`,
`P`, width and `Emax` of the uniform cascades; the collision check.

Assumptions, each labelled in the code with the same tag:

| Tag | Assumption | Why |
|---|---|---|
| A1 | A `1` flies for `(1 - r) B` and is held `r B`; it is handed from one hand's inside (throw) point to the other's. | A full dwell `2rB` is longer than the one beat a 1 has. The same ratio is applied to that one beat, so no new constant is needed. With r = 0.7 this is 0.3 of a beat. Jugglers bring the hands together for a 1. |
| A2 | A `2` is a hold and a `0` is an empty hand. | Standard siteswap convention. |
| A3 | Fountain: the two inside throw points are one `D1` apart, `P = F + D1`. | [K96] derives `E = F = W D1` but leaves the gap between the hands free ("approximately the width of the shoulders"). This keeps the same clearance there as on the arc. It gives 0.44 m for 4 balls and 0.55 m for 6. |
| A4 | A mixed siteswap uses the tempo and the throw and catch points of the uniform pattern of its highest throw, so that throw is exactly the cascade or fountain throw. | The spatial optimum is not derived for mixed patterns. [K96] notes that the high throw of a b-ball shower is "about the same as in a cascade with (2b - 1) balls". |
| A5 | Ghost hand path between catch and release: a cubic Hermite curve in time, with the hand still at the instant of the catch. A hold waits at the catch point and scoops one normal dwell before the release. | [K96]: "the exact path is unspecified". Only the catch and throw points are part of the optimum. The scoop depth that results (12 cm for 3 balls, 25 cm for 7) is a drawing choice. |
| A6 | Balls are thrown and caught at the same height. | The simplification used by [KL18] and by the `H` in juggling_coach. [K96] derives a small tilt (catch slightly above throw); it is not used. |
| A7 | Dwell ratio `r = 0.7` for every pattern. | It is what the [KL18] table uses (W = b/2 - 0.7). [K96] reports "near 2/3" and measures 0.63 to 0.71. |
| A8 | 3 balls: `P` = the measured dwell distance 0.20 m. 10 and 12 balls are interpolated between their neighbours; above 13 the 13-ball values are held. | With 3 balls `W < 1`, so `D1` and `Emax` do not exist and the theory leaves `P` free. No values are published for 10, 12 or beyond 13; the page flags these patterns. |
| A9 | Ball diameter 6 cm for everything. | The juggling_coach row. Kalvan's own measured patterns (3, 4, 6 balls) used 7.5 cm balls, so the `Emax` shown for those rows mixes his spacing with a 6 cm ball. |

Not physics at all, just defaults: hand height 1.05 m, eye height 1.65 m and 0.35 m from the
body until you calibrate (in VR the first guess is 0.6 m below your head); the peak-tone pitch
(220 Hz + 440 Hz x sqrt(height in metres)); the sound levels.

A note on the source: the book [KL18] itself was not on hand when this was built. Its table rows
were read from Google Books search snippets (p. 78) and cross-checked against the 7-ball row in
the juggling_coach README, which matches. The formulas were taken from the full text of [K96];
the snippets of [KL18] (pp. 56 to 59, 148 to 149) show the same formulas with `T` and `W` in
place of tau and omega. Anyone with the book should check the table rows for 5, 9, 11 and 13.

## Version 1 and version 2

| | Version 1 (this) | Version 2 (decided, later) |
|---|---|---|
| Siteswaps | Vanilla asynchronous | Synchronous as well |
| Layout | Kalvan optimum for uniform patterns; standard layout plus collision warning for the rest | Per-throw inside and outside throw and catch positions (for example 456 with the 6 thrown outside) |
| Tempo | Kalvan's published hand period, fixed | Adjustable beat time and dwell, physics recomputed so it stays juggleable |
| Your hands | Shown next to the ghosts, no judgement | Scoring your hands against the ghosts |

Decided against for now: clubs and rings, multiplex, passing, comparing real throws with the
ideal, custom hand tracking, draggable heights, lowered gravity.

Not done in version 1, and worth knowing:

- **Not yet tried on a real Quest 1.** The WebXR path is tested against an emulated Quest 1 (see
  Tests), which is not the same thing. First things to check in the headset: that the session
  starts, that the palm cup opens out of your palm, and that the control board is comfortable.
- The pattern is planar and sits about a forearm in front of your eyes, as in real juggling.
  Balls passing that close can be hard on the eyes in a headset; stepping back helps.

## Files

| File | What it is |
|---|---|
| `index.html` | The page, its styles and the favicon. Loads `src/main.js`. |
| `src/physics.js` | The math. Pure, no DOM. |
| `src/hands.js` | Ghost hand paths. Pure. |
| `src/describe.js` | The wording: what is exact, what is not covered. Pure. |
| `src/audio.js` | The three sounds (Web Audio, no audio files). |
| `src/scene.js` | three.js drawing. |
| `src/view.js` | Flat-screen camera: juggler's eye and orbit. |
| `src/xr.js` | WebXR session, controllers, palm point, movement. |
| `src/vrpanel.js` | The control board inside VR. |
| `src/ui.js`, `src/main.js` | On-page controls and the wiring. |
| `vendor/three.module.min.js` | three.js r160.1, vendored. Nothing is fetched from a CDN. |
| `test/*.test.js` | Unit tests. |
| `tools/serve.mjs`, `tools/smoke.mjs` | Local server and the browser smoke test. |

Kept conservative for the Quest 1 browser: no shadows or post-processing, unlit and Lambert
materials, a few dozen draw calls, plain ES modules with no build step.

## Tests

`npm test` runs 57 unit tests with `node --test`:

- siteswap validation, including clear refusals of synchronous and multiplex input;
- Shannon's theorem, measured from the generated throws, for 3 to 13 balls;
- the 7-ball optimum against the juggling_coach numbers, and the other published rows;
- flight time and height for each throw value, and that every ball really flies that path;
- collision detection: 456 collides, the presets do not, the detector reproduces Kalvan's
  grazing conditions exactly and agrees with brute-force time stepping;
- ghost hands: at the catch and release points on time, moving with the ball at release,
  scooping the right way round, alternating; no ball ever teleports;
- the wording (honesty notes, collision warning) and the sound rules (solo, pitch, timing).

`npm run smoke` drives the real page in headless Chromium: 38 checks on a laptop-sized screen, a
phone-sized screen, the live site's `/juggling/vr` path, and inside an emulated Oculus Quest 1
using Meta's [Immersive Web Emulation Runtime](https://github.com/meta-quest/immersive-web-emulation-runtime)
(trigger calibration, pointing at the board, keypad entry, slow-motion label, palm nudge,
stick movement, hand tracking). The emulator is a test-only dev dependency; the page never loads it.

## Deploying

The page is static. A deployed copy is exactly three things: `index.html`, `src/` and `vendor/`.

```
tools/deploy-copy.sh ~/personal-webpage/public/juggling/vr
```

The site (Next.js) does not serve directory indexes, so `'juggling/vr'` also has to be added to
`STATIC_APP_DIRS` in `next.config.mjs`. It then answers at `/juggling/vr` with no trailing slash.
`index.html` builds its script address from its own location for that reason, and the smoke test
covers `/juggling/vr`, `/juggling/vr/` and `/juggling/vr/index.html`.

## Sources

- **[S]** Claude E. Shannon, "Scientific Aspects of Juggling", in *Claude Elwood Shannon:
  Collected Papers*, IEEE Press, 1993, pp. 850-864. The juggling theorem.
- **[K96]** Jack Kalvan, "Optimal Juggling: The Analysis and Over-analysis of Juggling Patterns",
  1996. http://www.juggling.org/papers/OJ/ . Source of `W = b/h - r`, `H = g f²/8`, the optimal
  arc `F = W D`, the arc separation formula, the fountain result, the preferred dwell ratio, and
  the tables of measured hand periods and distances.
- **[KL18]** Jack Kalvan and Arthur Lewbel, *When Balls Collide: Understanding the Skill of
  Juggling*, 2018. Source of `D1`, `D2`, `Emax` and the "table of pattern parameters, examples of
  good patterns" (p. 78).
- **juggling_coach** https://github.com/GrahamPaasch/juggling_coach (README.txt). Shannon's
  theorem, the parameter definitions and the 7-ball row from [KL18].
- **WebXR Device API**, W3C. https://www.w3.org/TR/webxr/#dom-xrinputsource-gripspace . The grip
  space: "the pose that should be used to render virtual objects such that they appear to be held
  in the user's hand ... at the centroid of their curled fingers".
- **three.js** r160.1, MIT licence, vendored in `vendor/`.
