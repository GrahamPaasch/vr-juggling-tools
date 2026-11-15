# vr-juggling-tools
pattern visualization, picture in picture, suite of innovative tools

## VR juggling visualizer: see the ideal pattern (version 1)

One web page that shows cascades and fountains juggled the optimal way, using Jack Kalvan's
optimal-juggling math, and any other vanilla siteswap with exact timing and heights. Real gravity,
always. Put on a VR headset and stand in the juggler's spot, or open the same page on a laptop or
phone.

Live at https://www.grahampaasch.com/juggling/vr (how it gets there: [Deploying](#deploying)).
What to check in a real headset: [First time in the headset](#first-time-in-the-headset-not-done-yet).

The spec this was built from is `specs/35-vr-juggling-visualizer.md` in the voice-ui repo.

### What version 1 does

- **Patterns.** Any vanilla (alternating hands, one ball per throw) siteswap: `3`, `531`, `441`,
  `456`, `97531`. One character per throw; ten and up are letters (`a` is 10). Presets for the 3,
  4, 5, 6 and 7 ball cascades and fountains. Balls only. Synchronous and multiplex siteswaps are
  refused with a message that says why.
- **Physics is the math, only.** Exact flight time and height for every throw value from the beat
  time, the dwell and g = 9.81 m/s². Nothing on the page lets you drag a height or change gravity.
- **Kalvan's spatial optimum** for uniform cascades and fountains. For any other siteswap: exact
  timing and heights on a standard layout, and a warning (with red rings in the scene) if balls
  would collide. The page says which case you are looking at, where each number comes from, and
  where the computed numbers differ from the printed ones.
- **Tempo.** Always opens at real speed. Slow motion slows the clock and nothing else. Any speed
  other than 1x keeps a label such as `0.5x` on screen (head-locked in VR).
- **View.** Starts in the juggler's spot, first person. In VR you walk around the pattern (or move
  with the left stick, turn with the right stick). On a flat screen "Step out" orbits it.
- **Calibration.** Hold both controllers where you naturally catch and pull a trigger: that
  records hand height and distance from the body, and the pattern is built there. Both hands are
  needed; with one, the page says which is missing. The first time, calibration goes on to the
  palm (next point). Sliders (and plus/minus buttons in VR) fine-tune height and distance. A
  calibration is remembered together with the eye height it was made at and is used again only in
  that posture: sit down or stand up and you get a first guess and the prompt again. A guess is
  shown, never saved.
- **Hands.** Ghost hands do the correct scoop: catch outside, carry in and under, release inside,
  return over the top, hands alternating. Your own hands are drawn at the controllers so you can
  line them up with the ghosts. Hand tracking is an optional toggle.
- **Throw colours.** Every ball is white. In VR, each ball you "throw" takes a colour at its
  release from how well your hand followed the ghost hand through that scoop: green for the right
  motion at the right time, yellow for a little off, red for not right. It keeps the colour for
  its whole flight and is white again when caught, so the pattern itself shows which throws were
  good. No points, no streaks. See [Throw colours](#throw-colours).
- **Palm, not controller tip.** A ball lands at the WebXR grip pose, which is defined as the centre
  of the curled fingers (with tracked hands: the middle of the palm, built from the hand joints).
  Never at the pointing ray. After the first trigger calibration a ball rests in each hand and
  three nudges move it until it sits in your real palm; the pattern moves with it. "Palm ball" on
  the board brings that back later.
- **Sound.** Catch (a ball landing in a palm), release (the ball leaving the hand, about 4 dB
  quieter by default) and a peak tone at the exact top of each arc whose pitch follows the height.
  Each has its own volume, mute and solo, heard at once. Sounds are placed on the audio clock ahead
  of time, so the rhythm is as even as the math and not as uneven as the frame rate.

### Run it

```
npm run serve                 # http://localhost:8080, no build step and no dependencies
npm test                      # unit tests (node --test), no dependencies
npm install && npm run smoke  # headless Chromium, flat screen and an emulated Quest 1
npm run levels                # measures the release against the catch (see "Sound levels")
```

The smoke test uses Playwright's Chromium if it is installed (`npx playwright install chromium`)
and otherwise the Google Chrome on the machine.

WebXR only works on https or on localhost. To try a local copy in the headset before it is
deployed, connect it by USB and run `adb reverse tcp:8080 tcp:8080`, then open
`http://localhost:8080` in the headset browser. A plain `http://192.168...` link will not offer VR.

Useful addresses: `?s=531` opens a pattern, `?view=orbit` starts stepped out, `?layers=off` makes
VR draw through a plain WebGL layer (see "First time in the headset").

In VR the control board starts on your left, out of the way of the pattern. **A or X** brings it
in front of you, and hides it if you are already looking at it. Point at a button and pull the
trigger. Hide the board while you practise, so a stray trigger pull cannot press anything. The
left stick moves you (push it well over: a resting thumb does nothing), the right stick turns you
in 30 degree steps, and "my spot" on the board puts you back in the juggler's place.

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
quadruples the height. It follows that two throws in one pattern have heights in the ratio
`((n1 - 2r) / (n2 - 2r))²`, which is the formula [KL18] gives for siteswap throws (p. 129): in
`53` the 5 is about five times as high as the 3, not 5/3 as high. (With r = 0.7 the ratio is
5.06; the book's "between four and five times" fits dwell ratios from 0.5 to 0.69.)

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
room for error (set by `F`) as the juggler's preference, and derives the rest. This app takes them
from his published numbers, with `D = 6 cm` balls throughout:

| Balls | Pattern | T (s) | F (m) | r | Source |
|---|---|---|---|---|---|
| 3 | cascade | 0.55 | 0.33 (and hand travel E = 0.20) | 0.63 | [K96] measured, Kalvan's own pattern |
| 4 | fountain | 0.53 | 0.25 | 0.68 | [K96] measured, Kalvan's own pattern |
| 7 | cascade | 0.42 | 0.65 | 0.7 | [KL18] table of good patterns. Checked: it is the row quoted in juggling_coach |
| 5, 9, 11, 13 | cascade | 0.49, 0.35, 0.30, 0.27 | 0.52, 0.73, 0.80, 0.93 | 0.7 | [KL18] table, as read from search snippets. **Not yet checked against the book** (A10) |
| 6, 8, 10, 12 | fountain | 0.46, 0.38, 0.32, 0.28 | 0.37, 0.45, 0.52, 0.57 | 0.7 | [KL18] table, as read from search snippets. **Not yet checked against the book** (A10) |

14 balls and up have no published values: the tempo and ball spacing of the last published row of
the same kind are held, and the page says so.

**Check against the published figures.** From only `T`, `F`, `r` and `D`, the formulas above give
the following. The source's own figure is in brackets, and in bold where the computed value does
not come out as printed, at the precision printed. The page shows the same two columns side by
side.

| Balls | W | H (m) | D1 (m) | P (m) | Width (m) | Emax (deg) |
|---|---|---|---|---|---|---|
| 3 | 0.87 | 0.281 [**0.33** measured] | none | 0.200 (his E) | 0.530 | none |
| 4 | 1.32 | 0.600 [**0.65** measured] | 0.189 | A3 | 0.689 | 3.09 |
| 5 | 1.8 | 0.954 [1.0] | 0.289 [.29] | 0.322 [.32] | 0.842 [.84] | 3.44 [**3.3**] |
| 6 | 2.3 | 1.373 [1.4] | 0.161 [.16] | A3 | 0.901 [over 2F] | 1.05 [**1.0**] |
| **7** | 2.8 | 1.696 [1.7] | 0.232 [.23] | 0.263 [**.27**] | 0.913 [**.92**] | 1.45 [**1.4**] |
| 8 | 3.3 | 1.928 [**2.0**] | 0.136 [.14] | A3 | 1.036 [over 2F] | 0.57 [.57] |
| 9 | 3.8 | 2.169 [2.2] | 0.192 [.19] | 0.228 [.23] | 0.958 [.96] | 0.87 [**.84**] |
| 10 | 4.3 | 2.322 [**2.4**] | 0.121 [.12] | A3 | 1.161 [over 2F] | 0.38 [**.35**] |
| 11 | 4.8 | 2.543 [**2.6**] | 0.167 [.17] | 0.209 [**.22**] | 1.009 [**1.02**] | 0.60 [.60] |
| 12 | 5.3 | 2.701 [**2.8**] | 0.108 [.11] | A3 | 1.248 [over 2F] | 0.25 [.25] |
| 13 | 5.8 | 3.007 [3.0] | 0.160 [.16] | 0.215 [.22] | 1.145 [1.15] | 0.48 [.48] |

What that says, and no more:

- **7 balls**, the reference row (juggling_coach README: T = .42 s, W = 2.8, H = 1.7 m, F = .65 m,
  D1 = .23 m, P = .27 m, width .92 m, Emax 1.4°). T, W and F are inputs. H and D1 come out as
  printed. **P comes out 0.263 m, which is 6.5 mm under the printed .27; the width with it, 0.913
  against .92; and Emax 1.45° against 1.4°.** The page shows 26.3 cm, 91.3 cm and 1.45° with the
  book's 27 cm, 92 cm and 1.4° beside them.
- **Emax** has an explanation. In every row the book's figure is what its own printed, rounded
  `D1` and `H` give (to the printed digit, or within a hundredth of a degree):
  (0.23 - 0.06) / (4 x 1.7) = 1.43° for 7 balls. Ours is computed from the unrounded values.
- **H** for 8, 10, 11 and 12 balls comes out 6 to 10 cm under the printed figure. `T` is printed
  to two decimals, and each of those rows is within reach of a `T` inside its rounding interval,
  so this may be rounding. All four miss in the same direction, though, and the rows are
  unchecked.
- **P (and the width) for 7 and 11 balls is not explained.** `P` here is [K96]'s closed form for
  `D2 = D1`, and the collision detector confirms that it gives exactly equal clearance at the
  crossing and on the arc. Rounding of `T` and `F` does not account for the difference: over
  every `T` and `F` that would print as the table prints them, `P` for 7 balls runs from 0.260 to
  0.267 (and prints as .27 for under a quarter of those combinations), and for 11 balls it never
  exceeds 0.213 against the printed .22. With the printed `P = .27` the 7-ball crossing would have more
  room than the arc (`D2` = 0.238 against `D1` = 0.232). Either the book chooses `P` by something
  other than this formula, or (for 11 balls) the snippet was misread. The cause is not known. The
  derived value is kept, because it is the one that can be justified from a published formula.
- **3 and 4 balls.** The height is `g f²/8` from Kalvan's measured tempo and dwell ratio: 28.1 cm
  and 60.0 cm, against the 33 cm and 65 cm he measured. For the cascade, part of that is
  assumption A6 (his own formula with the catch above the throw gives 31 cm). The page shows both.
- For fountains the table prints no `P`, only that the pattern is wider than `2F`; the width
  shown is assumption A3 below.

The unit tests assert each of these statements, including the misses, value by value.

The collision detector (next section) independently finds a closest approach of exactly `D1` in
every one of these cascades, which checks both the formula for `P` and the detector.

### 4. Collision check (all patterns)

Two balls in flight share the same acceleration, so their separation changes linearly with time.
The closest approach of every pair of flights is therefore found exactly, with no time stepping.
Centres closer than one ball diameter count as a collision. `456` on the standard layout is a real
one: a 5 at its peak meets a rising 6, 4.5 cm between centres. That is the pattern the spec
suggests fixing with an outside throw in version 2. So is `75`, the 6-ball half shower (1.2 cm).
Of the 138 distinct mixed patterns up to period 4 with throws up to 7, 24 collide on the standard
layout, and each of them gets the warning.

Scope: balls in flight, in the ideal planar pattern. Balls being carried by a hand are not checked
by the detector; a unit test checks separately that a ball drawn in a ghost hand never overlaps
another ball in a pattern that carries no warning.

## What is exact and what is assumed

Exact, straight from the formulas above: flight time and height of every throw of 3 or more; when
and where every catch and release happens; which hand throws; the hand's velocity at release;
`W`, `D1`, `P`, width and `Emax` of the uniform cascades; the collision check.

Assumptions, each labelled in the code with the same tag:

| Tag | Assumption | Why |
|---|---|---|
| A1 | A `1` flies for `(1 - r) B` and is held `r B`. The hands come together for it: the ball is released half a ball diameter from the centre line on the thrower's side and caught half a ball diameter from it on the other side, so it crosses by exactly its own width (6 cm). | A full dwell `2rB` is longer than the one beat a 1 has. The same ratio is applied to that one beat, so no new constant is needed. With r = 0.7 this is 0.3 of a beat. The distance is the shortest hand-across in which the ball is wholly on the thrower's side when it is released and wholly on the catcher's side when it is caught, so neither hand reaches across the centre line (the same idea as A3). (Throwing the 1 between the two inside throw points instead would make it a 38.7 cm, 6 m/s flick on the 7-ball layout, faster than the 7 itself.) The page shows the distance and speed of the 1 and says that this is its own convention. |
| A2 | A `2` is a hold and a `0` is an empty hand. | Standard siteswap convention. |
| A3 | Fountain: the two inside throw points are one `D1` apart, `P = F + D1`, so the pattern is `2F + D1` wide. | The hands juggle independently, so the collision math does not fix the gap between them. [K96]: "approximately the width of the shoulders". [KL18]: shoulder width is comfortable, and jugglers do not reach across the centre line, so the pattern is wider than `2F`. This choice keeps the same clearance between the hands as on the arc. It gives P = 0.44 m for 4 balls and 0.53 m for 6. |
| A4 | A mixed siteswap uses the tempo, the dwell ratio and the throw and catch points of the uniform pattern of its highest throw, so that throw is exactly the cascade or fountain throw. | The spatial optimum is not derived for mixed patterns. [K96]: the high throw of a b-ball shower is "about the same as in a cascade with (2b - 1) balls". [KL18] p. 130: "7 1 is a four ball shower, but one hand does all the work of a seven ball cascade", and such patterns are recommended practice for the target number. So `71` and `7131` here show true 7-ball cascade throws. A pattern with no throw of 3 or more (`1`, `2`, `20`) borrows the 3-ball layout and tempo and is not said to contain "that throw". |
| A5 | Ghost hand path between catch and release: a cubic Hermite curve in time, with the hand still at the instant of the catch. A hold waits at the catch point and scoops one normal dwell before the release. | [K96]: "the exact path is unspecified". Only the catch and throw points are part of the optimum. The scoop depth that results (12 cm for 3 balls, 25 cm for 7) is a drawing choice. |
| A6 | Balls are thrown and caught at the same height. | The simplification used by [KL18] and by the `H` in juggling_coach. [K96]'s own optimal cascade catches above where it throws, by the dwell angle `tan(theta) = 2 Vh² / (g F)`. That is not small for low patterns: 16° and 5.4 cm for the 3-ball cascade here (a fifth of its height), 5.5° and 2.5 cm for 7 balls (1.5%). It is left out; for 3 balls it is part of why the height shown (28 cm) is under the 33 cm Kalvan measured. |
| A7 | Dwell ratio `r = 0.7` for the book's rows (5 balls and up); Kalvan's measured `r` for his own two rows, 0.63 for 3 balls and 0.68 for 4. | 0.7 is what the [KL18] table uses (W = b/2 - 0.7 on every row). The 3 and 4 ball rows are one real juggler's patterns, so they keep his own dwell ratio together with his tempo and width; with 0.7 the 3-ball cascade would peak 4 cm lower still (24 cm). Measured values vary: [K96] reports "near 2/3" (0.63 to 0.71), and [KL18] p. 68 measures 0.67 to 0.82 with an average of 0.75. Adjustable dwell is version 2. |
| A8 | 3 balls: `P` = Kalvan's measured hand travel `E` = 0.20 m. 14 balls and up: the tempo and spacing of the last published row of the same kind are held. | With 3 balls `W < 1`, so `D1` and `Emax` do not exist and the theory leaves `P` free. With throw and catch at one height (A6) the hand travels exactly `P`, so his measured `E` sets it. Nothing is published beyond 13 balls; the page flags those patterns. |
| A9 | Ball diameter 6 cm for everything. | The [KL18] table and the juggling_coach row. Kalvan's own measured patterns (the 3 and 4 ball rows) used 7.5 cm balls, which the page says; the `Emax` shown for 4 balls mixes his spacing with a 6 cm ball. |
| A10 | The [KL18] table rows for 5, 6 and 8 to 13 balls are taken as read from search snippets. | The book was not on hand when this was built, and its table could not be found online. Those eight rows were read from Google Books search snippets (p. 78) and have **not been checked against the book**. Only the 7-ball row is confirmed (it is quoted in juggling_coach), and the 3 and 4 ball rows come from the full text of [K96]. The page marks the eight rows as unchecked in the tag, the column header and the notes. One snippet value looks inconsistent: the 6-ball row reads F = 0.37 with a width "over 0.77", where 2F is 0.74; F = 0.37 is used because it agrees with the printed D1 and Emax. What this README quotes from other pages of the book (pp. 68, 129, 130, 149) was read from the same kind of snippet. **To do: read the nine rows off p. 78 and correct `PUBLISHED` in `src/physics.js`.** |

Not physics at all, just choices:

- **Before calibration:** hand height 1.05 m, eye height 1.65 m and 0.35 m from the body; in VR the
  first guess is 0.6 m below your head.
- **Posture:** a remembered calibration is used again only if your head is within 10 cm of the
  eye height it was made at. Sitting and standing differ by something like 40 cm, a tilted head by a few. (A threshold chosen between the two, not a measurement.)
- **Tracked hands:** the palm point is halfway along the middle metacarpal bone, raised out of the
  palm by the joint's own radius plus one ball radius. The nudges move it from there.
- **Sound:** the peak-tone pitch (220 Hz + 440 Hz x sqrt(height in metres)) and the levels (next).

### Sound levels

The spec asks for the release to be "a little quieter than catch", and audible. The two sounds
are very different: the catch is mostly a thump below 200 Hz, the release a short hiss around 3
to 4 kHz. So "how much quieter" depends on the meter. `npm run levels` renders both offline, as the
page makes them, and measures the loudest 50 ms. At the default sliders (catch 80%, release 65%)
the release is, relative to the catch:

| Meter | Release against catch |
|---|---|
| Peak | about -9 dB |
| RMS | about -16 dB |
| A-weighted (how the ear hears moderate sound) | about -4 dB |
| K-weighted (ITU-R BS.1770, broadcast loudness) | about -12 dB |
| K-weighted through a 250 Hz high-pass (a headset, phone or laptop speaker) | about -4 dB |

The level was set on the A-weighted figure, which agrees with the small-speaker one: the release
level at 100% (`BASE_LEVEL.release`) makes the two sounds equally loud at equal slider positions,
and the default sliders then put the release about 4 dB under. Before this it was 13 dB under on
that meter and 18 dB under on a peak meter. On full-range headphones the catch keeps its thump
and the release will sound quieter than that. None of this has been listened to on the Quest 1's
own speakers; it is on the list below, and the slider is there.

Changing a volume, mute or solo sets the gain of that sound's own bus and schedules nothing, so
it is heard at once and no sound can play twice. A change of speed or pattern cancels the sounds
that have not started and schedules from there again, leaving alone the ones that have.

## Throw colours

All balls are white. Inside VR, while a ghost hand makes its scoop (from the start of the carry
motion to the release) the page records your palm point on that side: the grip pose of the
controller, or the palm of a tracked hand, the same point a ball lands on. At the release the
recording is compared with the ghost's path and the ball that leaves takes a colour. It keeps it
until it is caught, then it is white again. Three things are measured, and the worst of the three
decides the colour:

| | Green up to | Yellow up to | Beyond: red |
|---|---|---|---|
| **Timing**: how early or late you made the motion (the shift in time that lays your path best over the ghost's) | 20% of the scoop's duration | 40% | |
| **Position**: the distance left between your palm and the ghost hand once that shift is taken out, root mean square over the scoop | 15% of the length of the ghost's scoop path, and never under 4 cm | 35%, and never under 8 cm | |
| **Direction**: the angle between the way your palm moved over the last 40% of the scoop and the way the ghost's did (its velocity at the release is the ball's launch velocity) | 35 degrees | 70 degrees | also red: a palm that hardly moved there (under a quarter of the ghost's travel) |

What those come to, for the uniform patterns:

| Pattern | Scoop lasts | Scoop path | Timing: green / yellow, at 1x | at 0.5x (real time) | Position: green / yellow |
|---|---|---|---|---|---|
| 3 | 0.347 s | 33 cm | 69 / 139 ms | 139 / 277 ms | 4.9 / 11.5 cm |
| 4 | 0.360 s | 49 cm | 72 / 144 ms | 144 / 288 ms | 7.3 / 17.0 cm |
| 5 | 0.343 s | 58 cm | 69 / 137 ms | 137 / 274 ms | 8.7 / 20.2 cm |
| 7 | 0.294 s | 60 cm | 59 / 118 ms | 118 / 235 ms | 8.9 / 20.8 cm |

- The limits scale with the pattern: bigger scoops allow more centimetres. Times are pattern
  time, so slow motion gives you proportionally more real time for the same colour.
- Distance out of the pattern's plane (nearer or farther from your body) counts half. Depth is
  the hardest thing to judge in a headset, and the math says nothing about it.
- The ghost's direction is read with a little slack in time (15% of the scoop either side), since
  on a curving path a small uncertainty in timing would otherwise show up as a large angle. Where
  the ghost itself travels under 8 cm in that last stretch (the hand-across before a 1) direction
  is left out.
- A hand waiting at the catch point before a hold (a 2) is not judged until its scoop starts.
- **No hand, no colour.** The ball stays white if the hand was not tracked through the scoop
  (more than a fifth of the frames without a palm, fewer than three samples, or tracking that
  began late or ended early). So everything is white on a flat screen, with a controller put down,
  and during calibration and the palm step, when the hands are held still on purpose.
- These limits are a first setting. They were tuned on simulated hands (one that follows the
  ghost 80 ms behind at 0.5x, 2 cm off, with 1.5 cm of wobble, is green on at least four throws
  in five, in the unit tests), not yet on a person in a headset. They are all in one place,
  `THRESHOLDS` at the top of `src/accuracy.js`.
- Cost on a Quest 1: four ball materials in all (white, green, yellow, red), shared by every
  ball; a colour change swaps a material, nothing is created. Each hand records into fixed arrays
  (64 samples, thinned out in slow motion) and one throw is judged in about a thousand evaluations
  of the ghost path, once, at its release.

## Version 1 and version 2

| | Version 1 (this) | Version 2 (decided, later) |
|---|---|---|
| Siteswaps | Vanilla asynchronous | Synchronous as well |
| Layout | Kalvan optimum for uniform patterns; standard layout plus collision warning for the rest | Per-throw inside and outside throw and catch positions (for example 456 with the 6 thrown outside) |
| Tempo | Kalvan's published hand period, fixed | Adjustable beat time and dwell, physics recomputed so it stays juggleable |
| Your hands | Shown next to the ghosts; each throw colours its ball by how well the hand followed (added 2026-11-15) | A running score, if wanted |

Decided against for now: clubs and rings, multiplex, passing, comparing real throws with the
ideal, custom hand tracking, draggable heights, lowered gravity.

Not done in version 1, and worth knowing:

- The pattern is planar and sits about a forearm in front of your eyes, as in real juggling.
  Balls passing that close can be hard on the eyes in a headset; stepping back helps.
- The keypad on the VR board has the digits 0 to 9. Throws of 10 and up (letters) can only be
  typed on the page.
- The hand-tracking toggle is on the page, under Calibration, and has to be set before entering
  VR (the browser grants it when the session starts). Tracked hands have no buttons: a pinch is
  the trigger, and the board stays where calibration put it, on your left.
- Your own controllers are drawn as a simple handle and a palm cup, not as a model of the
  controller: nothing is downloaded at run time.
- A device with nothing to hold (a phone in a cardboard viewer) cannot calibrate by trigger. The
  page says so, keeps the pattern in a standard place and leaves it to the sliders.

## First time in the headset (not done yet)

**This build has never run on a real Quest 1.** The spec asks for an early test there, because
that browser no longer gets updates. Everything about VR in this repository was checked against
an emulator inside current desktop Chromium, which says nothing about the headset's own browser,
its real grip pose, its speakers or its frame rate. In particular, a Quest browser has WebXR
Layers, so three.js draws through an `XRProjectionLayer` there; the emulator has none, so every
emulated check ran the other path, a plain `XRWebGLLayer`.

Do this once before calling version 1 done. Connect the headset by USB, run
`adb reverse tcp:8080 tcp:8080` and `npm run serve`, open `http://localhost:8080` in the headset
browser (or use the deployed https address), and check:

1. **The session starts.** Press Enter VR. Afterwards, back on the page, the note under the
   button reads "Last VR session: N frames a second on average, slowest frame M ms, drawn through
   XRProjectionLayer." Write that line down.
2. **The palm.** In the first calibration a white ball rests in each hand. With the controllers
   held as you hold balls, is it in your palm? If not, the three nudges on the board move it.
3. **Trigger calibration.** Hold both controllers where you catch and pull a trigger. The ghost
   hands should catch where your hands are.
4. **The board is readable** and its buttons can be hit with the trigger.
5. **Sound plays**, the catches are even, and the release is audible and a little quieter than
   the catch. (Its slider is there if the headset's speakers disagree with the measurements.)
6. **Throw colours.** At 0.5x with the 3-ball cascade, follow the ghost hands with your own.
   Do the balls you throw go green? Hold your hands still: they should go red. If careful
   following mostly gives yellow, the limits in `src/accuracy.js` are too strict for real hands.
7. **Seven balls hold the frame rate.** Load `7`, watch for a few seconds, leave VR, read the
   note again. A Quest 1 displays 72 frames a second.

If VR does not start, the note says why. If it starts but looks wrong (black, torn, or slow),
add `?layers=off` to the address: the page then draws through the plain `XRWebGLLayer`, the path
the emulator tests. The page also falls back to that by itself when the projection layer cannot
be set up at all.

## Files

| File | What it is |
|---|---|
| `index.html` | The page, its styles and the favicon. Loads `src/main.js`. |
| `src/physics.js` | The math, and the published numbers with their sources. Pure, no DOM. |
| `src/hands.js` | Ghost hand paths. Pure. |
| `src/schedule.js` | The clock (slow motion) and which sounds are due. Pure. |
| `src/calibration.js` | What a trigger pull records, posture, palm nudge. Pure. |
| `src/accuracy.js` | Throw colours: how a hand's scoop is judged against the ghost's. Pure. |
| `src/describe.js` | The wording: what is exact, what is not covered. Pure. |
| `src/audio.js` | The three sounds (Web Audio, no audio files). |
| `src/scene.js` | three.js drawing. |
| `src/view.js` | Flat-screen camera: juggler's eye and orbit. |
| `src/xr.js` | WebXR session, controllers and tracked hands, palm point, movement. |
| `src/vrpanel.js` | The control board inside VR. |
| `src/ui.js`, `src/main.js` | On-page controls and the wiring. |
| `vendor/three.module.min.js` | three.js r160.1, vendored. Nothing is fetched from a CDN. |
| `test/*.test.js` | Unit tests. |
| `tools/serve.mjs`, `tools/smoke.mjs` | Local server and the browser smoke test. |
| `tools/sound-levels.mjs` | Measures the release against the catch. |

Kept conservative for the Quest 1 browser: no shadows or post-processing, unlit and Lambert
materials, a few dozen draw calls (about 50 for both eyes, looking at the pattern with your own
hands in view, controllers or tracked hands), plain ES modules with no build step, and a draw loop
that reuses its objects instead of making garbage every frame.

## Tests

`npm test` runs 133 unit tests with `node --test`:

- siteswap validation against an independent landing simulation for every digit string up to
  length 4, clear refusals of synchronous and multiplex input, and messages that say what is
  really wrong (a throw landing on an empty beat; `10` typed for ten balls);
- Shannon's theorem, measured from the generated throws, for 3 to 13 balls;
- the 7-ball optimum, re-derived from scratch and compared with the juggling_coach numbers one by
  one: which five print the same and which three do not, with the size of each gap;
- every other published row, value by value, including the ones that are not reproduced, and
  what rounding can and cannot explain;
- flight time and height for each throw value, and that every ball really flies that path;
- the hand-across of a 1: one ball diameter, never faster than the pattern's highest throw;
- collision detection: 456 and 75 collide, the presets do not, the detector reproduces Kalvan's
  grazing conditions exactly and agrees with a simulator that shares no code with it;
- ghost hands: at the catch and release points on time, moving with the ball at release,
  scooping the right way round, no swing outward before a hand-across, alternating; no ball ever
  teleports, and no held ball overlaps another without a collision warning;
- throw colours: the exact motion is green; a motion made late or early, beside the path, or
  ending in the wrong direction is measured and graded at the documented limits; a still or
  backwards hand is red; the limits scale with the pattern; a careful mimic at 0.5x is mostly
  green; an untracked hand colours nothing; the colour is set at the release, kept through the
  flight and gone at the catch, at 30 and 72 frames a second and at 0.1x, with display times that
  step backwards, and without allocating in the frame loop;
- the clock: slow motion changes when things are shown and nothing else;
- sound: each event is handed to the audio clock once, also through hundreds of speed changes
  with any output latency; volume, mute and solo only set a gain; the clock that keeps the rhythm
  even; no audio context before a real gesture;
- calibration: what a trigger records, that it needs both hands, when a remembered calibration
  fits the posture, and that a palm nudge moves the pattern exactly as recalibrating would;
- the wording (sources, unchecked rows, honesty notes, collision warning);
- 500 random valid siteswaps and 2000 random strings: nothing breaks, nothing is silently wrong.

`npm run smoke` drives the real page in headless Chromium: 64 checks on a laptop-sized screen, a
phone-sized screen, the live site's `/juggling/vr` path, a browser without WebGL, and inside an
emulated Oculus Quest 1 using Meta's [Immersive Web Emulation Runtime](https://github.com/meta-quest/immersive-web-emulation-runtime)
(trigger calibration with one and two controllers, the palm step, pointing at the board, keypad
entry, slow-motion label, stick movement, sitting and standing, a late first head pose, an input
with no grip pose, a double press of Enter VR, the layer fallback, tracked hands; and the throw
colours: every ball white on the flat page, red from hands held still, green from emulated
controllers that follow the ghost hands at 0.5x, yellow from one that follows 8 cm too high,
white from a controller that is lost, and white while calibrating). It also
renders each sound offline and measures it (length, level, pitch, which ear), measures the gap
between scheduled catches (under 1 ms off), and drags the volume and speed sliders while checking
that no sound plays twice. The emulator is a test-only dev dependency; the page never loads it.

`SMOKE_CHANNEL=chrome` runs it in the installed Google Chrome, `SMOKE_EXECUTABLE=/path/to/chrome`
in any Chromium build, and `SMOKE_ONLY=flat,quest1` runs some of its parts. All 64 checks pass in
Chromium 141. (Before the throw colours were added, the 58 checks of that time also passed in
Chrome 149 and in Chromium 108 from late 2022, tried as a stand-in for an old browser; that has
not been run again.) Which Chromium the Quest 1's last browser is built on has not been
established here.

The emulator is not the headset: see [First time in the headset](#first-time-in-the-headset-not-done-yet).

## Deploying

The page is static. A deployed copy is exactly three things: `index.html`, `src/` and `vendor/`.

```
tools/deploy-copy.sh ~/personal-webpage/public/juggling/vr
```

The site (Next.js) does not serve directory indexes, so `'juggling/vr'` also has to be added to
`STATIC_APP_DIRS` in `next.config.mjs`. It then answers at `/juggling/vr` with no trailing slash.
`index.html` builds its script address from its own location for that reason, and the smoke test
covers `/juggling/vr`, `/juggling/vr/` and `/juggling/vr/index.html`.

Push `main` to GitHub before deploying: the page's "read the notes" link points at this README
in `GrahamPaasch/vr-juggling-tools`.

## Sources

- **[S]** Claude E. Shannon, "Scientific Aspects of Juggling", in *Claude Elwood Shannon:
  Collected Papers*, IEEE Press, 1993, pp. 850-864. The juggling theorem.
- **[K96]** Jack Kalvan, "Optimal Juggling: The Analysis and Over-analysis of Juggling Patterns",
  1996. http://www.juggling.org/papers/OJ/ . Source of `W = b/h - r`, `H = g f²/8`, the optimal
  arc `F = W D`, the arc separation formula, the dwell angle, the fountain result, the preferred
  dwell ratio, and the tables of measured hand periods and distances (the 3 and 4 ball rows used
  here: H 0.33 m, E 0.20 m, F 0.33 m, tau 0.55 s, r ~0.63; and H 0.65 m, E 0.25 m, F 0.25 m,
  tau 0.53 s, r ~0.68).
- **[KL18]** Jack Kalvan and Arthur Lewbel, *When Balls Collide: Understanding the Skill of
  Juggling*, 2018. Source of `D1`, `D2`, `Emax` and the "table of pattern parameters, examples of
  good patterns" (p. 78).
- **juggling_coach** https://github.com/GrahamPaasch/juggling_coach (README.txt). Shannon's
  theorem, the parameter definitions and the 7-ball row from [KL18].
- **WebXR Device API**, W3C. https://www.w3.org/TR/webxr/#dom-xrinputsource-gripspace . The grip
  space: "the pose that should be used to render virtual objects such that they appear to be held
  in the user's hand ... at the centroid of their curled fingers".
- **WebXR Hand Input Module**, W3C. https://www.w3.org/TR/webxr-hand-input-1/ . A joint sits at
  the wrist end of the bone it is named after, with "-Y direction pointing perpendicular to the
  skin, outwards from the palm, and -Z direction pointing along their associated bone, away from
  the wrist"; its radius reaches the skin.
- **IEC 61672** (A-weighting) and **ITU-R BS.1770** (K-weighting), for the sound-level figures.
- **three.js** r160.1, MIT licence, vendored in `vendor/`.
