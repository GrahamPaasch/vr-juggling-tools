import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NORMAL, COLORBLIND, OUTLINE_SCALE } from '../src/palette.js';
import { GRADE } from '../src/accuracy.js';

// sRGB hex to linear RGB, relative luminance and CIE lightness L* (0 black .. 100 white).
const lin = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map(lin);
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const lightness = (y) => (y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y);

/**
 * How a ball looks on screen, roughly: the Lambert colour lit by `light` (scene.js has a
 * hemisphere light of 2.2 and a sun of 2.0, about 1.2 on the lit side of a ball, 0.35 on the
 * side away from both) plus the emissive glow, clipped as the screen clips it.
 */
const drawn = (look, light) => rgb(look.color).map((c) => Math.min(1, c * light + c * look.intensity));

// Machado, Oliveira and Fernandes (2009), full severity, on linear RGB.
const CVD = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};
const see = (m, c) => m.map((row) => Math.min(1, Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2])));
const VISIONS = { normal: null, ...CVD, grayscale: 'gray' };
const viewed = (vision, c) => (vision === 'gray' ? [luminance(c), luminance(c), luminance(c)] : vision ? see(vision, c) : c);
const L = (vision, look, light) => lightness(luminance(viewed(vision, drawn(look, light))));

// CIE Lab, for "do two colours look different" (delta E 1976).
const lab = (c) => {
  const x = (0.4124 * c[0] + 0.3576 * c[1] + 0.1805 * c[2]) / 0.95047;
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const z = (0.0193 * c[0] + 0.1192 * c[1] + 0.9505 * c[2]) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
};
const deltaE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));

const LIGHTS = [1.2, 0.7, 0.35];

test('palette: one look per grade, in GRADE order, in both palettes', () => {
  assert.equal(NORMAL.length, 4);
  assert.equal(COLORBLIND.length, 4);
  assert.equal(Object.keys(GRADE).length, 4);
  assert.equal(NORMAL[GRADE.NONE].color, 0xffffff, 'the everyday look is unchanged: white');
  assert.deepEqual(
    NORMAL.map((l) => l.color),
    [0xffffff, 0x35d45f, 0xffd21f, 0xff3b3b]
  );
  for (const look of [...NORMAL, ...COLORBLIND]) {
    assert.ok(Number.isInteger(look.color) && look.color >= 0 && look.color <= 0xffffff);
    assert.ok(look.intensity >= 0 && look.intensity <= 1);
  }
});

test('colorblind: the brightness order is good > unjudged > ok > bad, under every kind of colour vision and in pure grayscale', () => {
  for (const [name, vision] of Object.entries(VISIONS)) {
    for (const light of LIGHTS) {
      const good = L(vision, COLORBLIND[GRADE.GREEN], light);
      const none = L(vision, COLORBLIND[GRADE.NONE], light);
      const ok = L(vision, COLORBLIND[GRADE.YELLOW], light);
      const bad = L(vision, COLORBLIND[GRADE.RED], light);
      const at = name + ', light ' + light + ': L* ' + [good, none, ok, bad].map((v) => v.toFixed(0)).join(' / ');
      // Clearly separated steps of lightness, at the same spot on the ball.
      assert.ok(good - none >= 20, 'good is much brighter than an unjudged ball (' + at + ')');
      assert.ok(none - ok >= 10, 'unjudged is brighter than ok (' + at + ')');
      assert.ok(ok - bad >= 20, 'ok is much brighter than bad (' + at + ')');
      assert.ok(bad <= 15, 'bad is dark (' + at + ')');
    }
  }
});

test('colorblind: good is the brightest wherever it is seen; even its shaded side outshines the lit side of ok and bad', () => {
  for (const [name, vision] of Object.entries(VISIONS)) {
    const goodShade = L(vision, COLORBLIND[GRADE.GREEN], 0.35);
    assert.ok(goodShade >= 70, name + ': a good ball glows (' + goodShade.toFixed(0) + ')');
    assert.ok(goodShade > L(vision, COLORBLIND[GRADE.YELLOW], 1.2) + 15, name + ': shaded good vs lit ok');
    assert.ok(goodShade > L(vision, COLORBLIND[GRADE.RED], 1.2) + 50, name + ': shaded good vs lit bad');
  }
});

test('colorblind: unjudged is a neutral gray, good is blue, ok is orange', () => {
  const [r, g, b] = [(COLORBLIND[0].color >> 16) & 255, (COLORBLIND[0].color >> 8) & 255, COLORBLIND[0].color & 255];
  assert.ok(r === g && g === b, 'gray');
  const blue = rgb(COLORBLIND[GRADE.GREEN].color);
  assert.ok(blue[2] > blue[1] && blue[1] > blue[0], 'blue');
  const orange = rgb(COLORBLIND[GRADE.YELLOW].color);
  assert.ok(orange[0] > orange[1] && orange[1] > orange[2], 'orange');
});

test('colorblind: the three grades and unjudged look clearly different for protan, deutan and tritan eyes', () => {
  for (const [name, vision] of Object.entries(CVD)) {
    const c = COLORBLIND.map((look) => see(vision, drawn(look, 0.7)));
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const d = deltaE(c[i], c[j]);
        assert.ok(d >= 15, name + ': grades ' + i + ' and ' + j + ' differ by delta E ' + d.toFixed(1));
      }
    }
  }
});

test('the normal palette really is hard for red-green colour blindness (why the toggle exists)', () => {
  // Seen by a deutan eye (the most common kind), the normal green and red are nearly the same
  // hue: what is left is a small difference in lightness. The colorblind palette keeps its grades
  // far apart in lightness alone.
  const hue = (c) => lab(c).slice(1);
  const n = NORMAL.map((look) => see(CVD.deutan, drawn(look, 0.7)));
  const greenRed = Math.hypot(...hue(n[GRADE.GREEN]).map((v, i) => v - hue(n[GRADE.RED])[i]));
  assert.ok(greenRed < 15, 'normal green vs red, hue difference for deutan: ' + greenRed.toFixed(1));
  const c = COLORBLIND.map((look) => lab(see(CVD.deutan, drawn(look, 0.7)))[0]);
  const gaps = [c[GRADE.GREEN] - c[GRADE.YELLOW], c[GRADE.YELLOW] - c[GRADE.RED]];
  assert.ok(Math.min(...gaps) >= 25, 'colorblind grades, lightness steps for deutan: ' + gaps.map((g) => g.toFixed(0)));
});

test('colorblind: only "bad" has the white outline, and it is thin', () => {
  assert.deepEqual(
    COLORBLIND.map((l) => l.outline === true),
    [false, false, false, true]
  );
  assert.ok(NORMAL.every((l) => !l.outline), 'the normal palette has none');
  assert.ok(OUTLINE_SCALE > 1.05 && OUTLINE_SCALE < 1.25, 'a rim of 5 to 25% of the radius');
});
