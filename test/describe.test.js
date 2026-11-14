import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPattern, findCollisions } from '../src/physics.js';
import { describePattern, formatSpeed, fmt } from '../src/describe.js';

const describe = (text) => {
  const pattern = buildPattern(text);
  return describePattern(pattern, findCollisions(pattern));
};
const allText = (d) => [d.title, d.tag, d.notes.join(' '), d.collision ? d.collision.text : '', d.rows.map((r) => r.join(' ')).join(' ')].join(' ');

test('speed label: real speed is 1x, anything else reads like 0.5x', () => {
  assert.equal(formatSpeed(1), '1x');
  assert.equal(formatSpeed(0.5), '0.5x');
  assert.equal(formatSpeed(0.25), '0.25x');
  assert.equal(formatSpeed(0.1), '0.1x');
});

test('units read naturally', () => {
  assert.equal(fmt.metres(1.696), '1.70 m');
  assert.equal(fmt.metres(0.2374), '23.7 cm');
  assert.equal(fmt.seconds(1.176), '1.176 s');
  assert.equal(fmt.degrees(1.4541), '1.45°');
});

test('7 balls is presented as Kalvan’s spatial optimum with the juggling_coach numbers', () => {
  const d = describe('7');
  assert.equal(d.title, '7-ball cascade');
  assert.match(d.tag, /spatial optimum/);
  const text = allText(d);
  for (const expected of ['0.42 s', 'W = 2.80', '1.176 s', '1.70 m', '65.0 cm', '23.2 cm', '1.45°']) {
    assert.ok(text.includes(expected), 'missing ' + expected);
  }
  assert.equal(d.collision, null, 'no collision talk for an optimal uniform pattern');
});

test('honest about 3 balls: no arc spacing and no error limit exist', () => {
  const d = describe('3');
  assert.match(d.tag, /measured/);
  const text = allText(d);
  assert.match(text, /none \(W < 1\)/);
  assert.match(text, /not defined/);
  assert.match(text, /less than one ball in the air per hand/);
});

test('honest about fountains: the gap between the hands is our assumption', () => {
  for (const text of ['4', '6', '8']) {
    const d = describe(text);
    assert.match(d.tag, /hand spacing assumed/);
    assert.match(d.notes.join(' '), /our assumption, not his/);
    assert.match(d.notes.join(' '), /own side of the centre line/);
  }
});

test('honest about mixed siteswaps: exact timing, borrowed layout, optimum not derived', () => {
  const d = describe('531');
  assert.equal(d.title, '531 · 3 balls');
  assert.match(d.tag, /Exact timing, standard layout/);
  const notes = d.notes.join(' ');
  assert.match(notes, /Flight times and heights are exact/);
  assert.match(notes, /only derived for uniform cascades and fountains/);
  assert.match(notes, /5-ball cascade/);
  assert.equal(d.collision.bad, false);
  assert.match(d.collision.text, /No collisions/);
  // One row per throw value, highest first, with flight time and height.
  assert.deepEqual(d.rows.map((r) => r[0]), ['5', '3', '1']);
  assert.match(d.rows[2][2], /handed across/);
});

test('456 carries a collision warning that names the throws and the distance', () => {
  const d = describe('456');
  assert.equal(d.collision.bad, true);
  assert.match(d.collision.text, /would collide/);
  assert.match(d.collision.text, /the 5 and the 6/);
  assert.match(d.collision.text, /4\.5 cm apart/);
  assert.match(d.collision.text, /version 2/);
  assert.equal(d.vrStatusKind, 'warn');
  assert.match(d.vrStatus, /COLLISION/);
});

test('holds and empty hands are named, not given a flight', () => {
  const d = describe('420');
  assert.deepEqual(d.rows.map((r) => r.slice(0, 2)), [
    ['4', d.rows[0][1]],
    ['2', 'held'],
    ['0', 'empty hand'],
  ]);
});

test('numbers with no published row are flagged in the tag and the notes', () => {
  const fourteen = describe('e');
  assert.match(fourteen.tag, /No published values: extrapolated/);
  assert.match(fourteen.notes.join(' '), /no published values/);
  const mixed = describe('e8'); // highest throw 14 borrows the extrapolated row
  assert.match(mixed.notes.join(' '), /no published values for a 14-ball fountain/);
  // Everything in the table is presented as published.
  for (const text of ['5', '6', '7', '8', '9', 'a', 'b', 'c', 'd']) assert.doesNotMatch(describe(text).tag, /No published/);
});
