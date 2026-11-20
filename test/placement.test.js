import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_PLACEMENT,
  MAX_OFFSET,
  applyPlacement,
  centreOf,
  cleanPlacement,
  dragTo,
  headingOf,
  placementFrom,
  rotate,
  spotFor,
  wrapAngle,
} from '../src/placement.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= (tol || 1e-9), `${msg || ''}: ${a} vs ${b}`);
const forward = (yaw) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });

test('placement: rotate turns a heading the same way yaw does', () => {
  for (const yaw of [0, 0.4, -1.2, 2.9]) {
    const f = rotate(0, -1, yaw);
    near(f.x, forward(yaw).x);
    near(f.z, forward(yaw).z);
    near(headingOf(f.x, f.z), yaw, 1e-9, 'heading of the forward vector is the yaw');
  }
  assert.ok(Number.isNaN(headingOf(0.01, 0.02)), 'straight up or down has no heading');
});

test('placement: centreOf and spotFor are inverses', () => {
  const a = { spotX: 0.4, spotZ: -1.1, yaw: 0.7, handHeight: 1.0, distance: 0.42 };
  const c = centreOf(a);
  near(c.y, 1.0);
  const s = spotFor(c.x, c.z, a.yaw, a.distance);
  near(s.spotX, a.spotX);
  near(s.spotZ, a.spotZ);
  // The centre is `distance` in front of the spot.
  near(Math.hypot(c.x - a.spotX, c.z - a.spotZ), 0.42);
  near(c.x - a.spotX, forward(a.yaw).x * 0.42);
});

test('placement: zero placement puts the spot on the base, facing its way', () => {
  const base = { x: 1.3, z: -0.2, yaw: 1.1 };
  const p = applyPlacement(base, NO_PLACEMENT);
  near(p.spotX, 1.3);
  near(p.spotZ, -0.2);
  near(p.yaw, 1.1);
});

test('placement: right and forward are in the base person\'s own directions', () => {
  // Facing -X (yaw 90 deg left): forward is -X, right is -Z.
  const base = { x: 0, z: 0, yaw: Math.PI / 2 };
  const p = applyPlacement(base, { right: 0.3, forward: 0.5, turn: 0 });
  near(p.spotX, -0.5);
  near(p.spotZ, -0.3);
});

test('placement: placementFrom and applyPlacement round-trip from any base', () => {
  const bases = [
    { x: 0, z: 0, yaw: 0 },
    { x: 2, z: -1, yaw: -2.5 },
    { x: -0.4, z: 3, yaw: 3.0 },
  ];
  const anchor = { spotX: 0.35, spotZ: -0.6, yaw: 0.25 };
  for (const base of bases) {
    const placed = placementFrom(base, anchor);
    const back = applyPlacement(base, placed);
    near(back.spotX, anchor.spotX);
    near(back.spotZ, anchor.spotZ);
    near(wrapAngle(back.yaw - anchor.yaw), 0);
  }
});

test('placement: a placement means the same thing relative to the person on the next entry', () => {
  // Session 1: person at the origin facing -Z drags the pattern 0.2 m right and turns it 10 deg.
  const base1 = { x: 0, z: 0, yaw: 0 };
  const placed = placementFrom(base1, { spotX: 0.2, spotZ: 0, yaw: 0.1745 });
  // Saved and read back as the page does.
  const saved = cleanPlacement(JSON.parse(JSON.stringify(placed)));
  near(saved.right, 0.2);
  near(saved.turn, 0.1745);
  // Session 2: the headset's origin is somewhere else and the person faces +X (yaw -90 deg).
  const base2 = { x: 5, z: 7, yaw: -Math.PI / 2 };
  const again = applyPlacement(base2, saved);
  // Facing +X, their right is +Z.
  near(again.spotX, 5);
  near(again.spotZ, 7.2);
  near(again.yaw, -Math.PI / 2 + 0.1745);
});

test('placement: cleanPlacement refuses junk and far-away placements', () => {
  assert.deepEqual(cleanPlacement(null), NO_PLACEMENT);
  assert.deepEqual(cleanPlacement('x'), NO_PLACEMENT);
  assert.deepEqual(cleanPlacement({ right: NaN, forward: 0, turn: 0 }), NO_PLACEMENT);
  assert.deepEqual(cleanPlacement({ right: 0, forward: '1', turn: 0 }), NO_PLACEMENT);
  assert.deepEqual(cleanPlacement({ right: MAX_OFFSET, forward: 1, turn: 0 }), NO_PLACEMENT);
  const ok = cleanPlacement({ right: 0.1, forward: -0.2, turn: 7 });
  near(ok.turn, wrapAngle(7));
  near(ok.right, 0.1);
});

test('drag: moving the hand moves the pattern by the same amount', () => {
  const grab = { hand: { x: 0.2, y: 1.0, z: -0.3, heading: 0 }, centre: { x: 0, y: 0.95, z: -0.45 }, yaw: 0 };
  const to = dragTo(grab, { x: 0.5, y: 1.2, z: -0.1, heading: 0 });
  near(to.x, 0.3);
  near(to.y, 1.15);
  near(to.z, -0.25);
  near(to.yaw, 0);
});

test('drag: turning the hand turns the pattern about the hand', () => {
  const grab = { hand: { x: 0, y: 1, z: 0, heading: 0 }, centre: { x: 0, y: 1, z: -0.5 }, yaw: 0 };
  const to = dragTo(grab, { x: 0, y: 1, z: 0, heading: Math.PI / 2 });
  // A quarter turn left about the hand: the centre half a metre ahead goes half a metre to -X.
  near(to.x, -0.5);
  near(to.z, 0);
  near(to.yaw, Math.PI / 2);
  // A distance kept: held rigidly.
  near(Math.hypot(to.x, to.z), 0.5);
});

test('drag: a hand with no heading moves the pattern without turning it', () => {
  const grab = { hand: { x: 0, y: 1, z: 0, heading: NaN }, centre: { x: 0, y: 1, z: -0.5 }, yaw: 0.3 };
  const to = dragTo(grab, { x: 0.1, y: 1, z: 0, heading: 1.0 });
  near(to.x, 0.1);
  near(to.z, -0.5);
  near(to.yaw, 0.3);
});

test('drag: the hand back where it took hold leaves the pattern exactly where it was', () => {
  const grab = { hand: { x: 0.3, y: 0.9, z: -0.2, heading: 0.4 }, centre: { x: 0.1, y: 1.0, z: -0.6 }, yaw: -0.2 };
  const to = dragTo(grab, { ...grab.hand });
  near(to.x, 0.1);
  near(to.y, 1.0);
  near(to.z, -0.6);
  near(to.yaw, -0.2);
});
