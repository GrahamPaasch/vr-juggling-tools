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

test('7 balls is presented as Kalvan’s spatial optimum, with the juggling_coach numbers beside the computed ones', () => {
  const d = describe('7');
  assert.equal(d.title, '7-ball cascade');
  assert.equal(d.tag, 'Kalvan\'s spatial optimum');
  assert.equal(d.tagClass, '');
  assert.deepEqual(d.header, ['', 'Here', 'Book']);
  assert.equal(d.tableClass, 'compare');
  const row = (label) => d.rows.find((r) => r[0].startsWith(label));
  // Computed here | printed in the book (the eight numbers of the spec: T .42, W 2.8, H 1.7,
  // F .65, D1 .23, P .27, width .92, Emax 1.4).
  assert.deepEqual(row('Hand period T').slice(1), ['0.42 s', '0.42 s']);
  assert.deepEqual(row('Dwell ratio r').slice(1), ['0.70 (W = 2.80)', 'W = 2.8']);
  assert.deepEqual(row('Flight time f').slice(1), ['1.176 s', '']);
  assert.deepEqual(row('Height above the hands H').slice(1), ['1.70 m', '1.7 m']);
  assert.deepEqual(row('Flight distance F').slice(1), ['65.0 cm', '65 cm']);
  assert.deepEqual(row('Spacing on one arc D1').slice(1), ['23.2 cm', '23 cm']);
  assert.deepEqual(row('Arc separation P').slice(1), ['26.3 cm', '27 cm']);
  assert.deepEqual(row('Pattern width F + P').slice(1), ['91.3 cm', '92 cm']);
  assert.deepEqual(row('Throw error allowed Emax').slice(1), ['1.45°', '1.4°']);
  // The three that differ are named, and no cause is made up for them.
  const notes = d.notes.join(' ');
  assert.match(notes, /Not reproduced at the printed precision: P, the width, Emax\./);
  assert.match(notes, /D2 = D1/);
  assert.match(notes, /not known/);
  assert.doesNotMatch(notes, /rounding/);
  assert.equal(d.collision, null, 'no collision talk for an optimal uniform pattern');
});

test('table rows read from search snippets say so on the page, in the tag, the header and the notes', () => {
  for (const text of ['5', '6', '8', '9', 'a', 'b', 'c', 'd']) {
    const d = describe(text);
    assert.match(d.tag, /table row unchecked/, text);
    assert.equal(d.tagClass, 'mixed', text + ': not shown in the colour of a checked pattern');
    assert.equal(d.vrStatusKind, 'plain', text);
    assert.match(d.vrStatus, /unchecked/, text + ': and inside VR too');
    assert.deepEqual(d.header, ['', 'Here', 'Snippet'], text);
    assert.match(d.notes[0], /^Careful: T and F, and the Snippet column, were read from search snippets/, text);
    assert.match(d.notes[0], /not been checked against the book/, text);
  }
  // The row that is checked (it is quoted in juggling_coach) carries none of that.
  const seven = describe('7');
  assert.doesNotMatch(allText(seven), /unchecked|snippets|Careful/);
  // A mixed pattern that borrows an unchecked row says so as well; one on the 7-ball row does not.
  assert.match(describe('531').notes.join(' '), /Careful: the tempo and width of that 5-ball cascade were read from search snippets/);
  assert.doesNotMatch(describe('71').notes.join(' '), /Careful/);
  assert.doesNotMatch(describe('441').notes.join(' '), /Careful/);
  // Where a snippet row is not reproduced, the possibility of a misread is stated.
  assert.match(describe('b').notes.join(' '), /Not reproduced at the printed precision: H, P, the width\..*a misread snippet is possible/);
  // 13 balls reproduces everything printed, so it has no such note.
  assert.doesNotMatch(describe('d').notes.join(' '), /Not reproduced/);
});

test('honest about 3 balls: Kalvan’s measured cascade, his height beside ours, no arc spacing or error limit', () => {
  const d = describe('3');
  assert.equal(d.tag, 'Kalvan\'s measured cascade');
  assert.deepEqual(d.header, ['', 'Here', 'Measured']);
  const row = (label) => d.rows.find((r) => r[0].startsWith(label));
  assert.deepEqual(row('Hand period T').slice(1), ['0.55 s', '0.55 s']);
  assert.deepEqual(row('Dwell ratio r').slice(1), ['0.63 (W = 0.87)', 'about 0.63']);
  assert.deepEqual(row('Height above the hands H').slice(1), ['28.1 cm', '33 cm']);
  assert.deepEqual(row('Flight distance F').slice(1), ['33.0 cm', '33 cm']);
  assert.deepEqual(row('Arc separation P').slice(1), ['20.0 cm', '20 cm (his E)']);
  const text = allText(d);
  assert.match(text, /none \(W < 1\)/);
  assert.match(text, /not defined/);
  assert.match(text, /less than one ball in the air per hand/);
  assert.match(text, /hand travel E he measured/);
  assert.doesNotMatch(text, /P is his measured value/);
  // The height is not passed off as his: both are given, with the reason the model has.
  const notes = d.notes.join(' ');
  assert.match(notes, /Kalvan measured his peak at 33 cm above his throw point\. The formula H = g f²\/8 gives 28\.1 cm/);
  assert.match(notes, /throws and catches at one height \(assumption A6/);
  assert.match(notes, /7\.5 cm balls/);
  // 4 balls likewise.
  const four = describe('4');
  assert.match(four.tag, /measured fountain/);
  assert.deepEqual(four.rows.find((r) => r[0].startsWith('Height')).slice(1), ['60.0 cm', '65 cm']);
  assert.deepEqual(four.rows.find((r) => r[0].startsWith('Dwell')).slice(1), ['0.68 (W = 1.32)', 'about 0.68']);
  assert.match(four.notes.join(' '), /Kalvan measured his peak at 65 cm\. The formula/);
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
  // The 1 says how far it is handed, and the notes say whose convention that is.
  assert.match(d.rows[2][2], /handed across 6\.0 cm/);
  assert.match(notes, /A 1 is handed straight across: the hands meet in the middle/);
  assert.match(notes, /6\.0 cm at 0\.9 m\/s/);
  assert.match(notes, /this page’s convention, not part of Kalvan’s math/);
  assert.match(notes, /so its highest throw is exactly that throw/);
});

test('patterns with nothing thrown high are not described as if they had a highest throw', () => {
  // 1, 2 and 20 borrow the 3-ball layout, but none of them contains a 3.
  for (const text of ['1', '11', '2', '20', '22', '202']) {
    const p = buildPattern(text);
    if (!p.ok) continue;
    const notes = describePattern(p, findCollisions(p)).notes.join(' ');
    assert.match(notes, /borrows the hand positions and tempo of Kalvan’s 3-ball cascade\./, text);
    assert.doesNotMatch(notes, /highest throw is exactly that throw/, text);
  }
  // Nothing flies in 2 or 20, so no flight times are claimed.
  for (const text of ['2', '20']) {
    const notes = describe(text).notes.join(' ');
    assert.doesNotMatch(notes, /Flight times and heights are exact/, text);
    assert.match(notes, /Nothing is thrown in this pattern: a 2 is a ball held in the hand/, text);
  }
  assert.match(describe('20').notes.join(' '), /a 0 is an empty hand/);
  // A 1 does fly: its flight is stated, with the convention.
  const one = describe('1').notes.join(' ');
  assert.match(one, /Flight times and heights are exact/);
  assert.match(one, /A 1 is handed straight across/);
  // A real pattern keeps the sentence.
  assert.match(describe('423').notes.join(' '), /so its highest throw is exactly that throw/);
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

test('75 (the 6-ball half shower) is valid and carries the collision warning', () => {
  const d = describe('75');
  assert.equal(d.title, '75 · 6 balls');
  assert.equal(d.collision.bad, true);
  assert.match(d.collision.text, /the 7 and the 5 pass 1\.2 cm apart|the 5 and the 7 pass 1\.2 cm apart/);
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
