import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findCycles, findUnresolvedSeniors, descendantsOf } from '../src/lib/tree.js';

const tree = (pairs) => new Map(pairs);

describe('findCycles', () => {
  test('a normal hierarchy has none', () => {
    const edges = tree([
      ['A', null],
      ['B', 'A'],
      ['C', 'A'],
      ['D', 'B'],
      ['E', 'B'],
    ]);
    assert.deepEqual(findCycles(edges), []);
  });

  test('catches a two-person loop', () => {
    const cycles = findCycles(tree([['A', 'B'], ['B', 'A']]));
    assert.equal(cycles.length, 1);
    assert.deepEqual([...cycles[0]].sort(), ['A', 'B']);
  });

  test('catches a three-person loop', () => {
    const cycles = findCycles(tree([['A', 'B'], ['B', 'C'], ['C', 'A']]));
    assert.equal(cycles.length, 1);
    assert.deepEqual([...cycles[0]].sort(), ['A', 'B', 'C']);
  });

  test('catches a loop hanging off a valid tree', () => {
    const cycles = findCycles(tree([
      ['ROOT', null],
      ['A', 'ROOT'],
      ['X', 'Y'],
      ['Y', 'Z'],
      ['Z', 'X'],
    ]));
    assert.equal(cycles.length, 1);
    assert.deepEqual([...cycles[0]].sort(), ['X', 'Y', 'Z']);
  });

  test('reports each distinct loop once, not once per member', () => {
    const cycles = findCycles(tree([
      ['A', 'B'], ['B', 'A'],
      ['C', 'D'], ['D', 'C'],
    ]));
    assert.equal(cycles.length, 2);
  });

  test('self-reporting is a loop of one', () => {
    const cycles = findCycles(tree([['A', 'A']]));
    assert.equal(cycles.length, 1);
    assert.deepEqual(cycles[0], ['A']);
  });

  test('terminates on a dangling senior rather than hanging', () => {
    assert.deepEqual(findCycles(tree([['A', 'GHOST']])), []);
  });
});

describe('findUnresolvedSeniors', () => {
  test('finds a senior who exists nowhere', () => {
    const missing = findUnresolvedSeniors(tree([['A', 'GHOST'], ['B', 'A']]));
    assert.deepEqual(missing, ['GHOST']);
  });

  test('accepts a senior already in the database', () => {
    const missing = findUnresolvedSeniors(tree([['A', 'EXISTING']]), new Set(['EXISTING']));
    assert.deepEqual(missing, []);
  });

  test('accepts a senior defined later in the same file', () => {
    // reports_to may point at somebody further down the CSV — that is normal
    // and must not be reported as missing. FRD BR-MST-3.
    const missing = findUnresolvedSeniors(tree([['A', 'B'], ['B', null]]));
    assert.deepEqual(missing, []);
  });
});

describe('descendantsOf', () => {
  const org = tree([
    ['ADMIN', null],
    ['S1', 'ADMIN'],
    ['S2', 'ADMIN'],
    ['E1', 'S1'],
    ['E2', 'S1'],
    ['E3', 'S2'],
    ['E4', 'E1'], // indirect — two levels down
  ]);

  test('a senior sees their whole chain, direct and indirect', () => {
    assert.deepEqual(descendantsOf('S1', org).sort(), ['E1', 'E2', 'E4']);
  });

  test('a senior never sees a peer or a peer\'s team', () => {
    const visible = descendantsOf('S1', org);
    assert.ok(!visible.includes('S2'));
    assert.ok(!visible.includes('E3'));
    assert.ok(!visible.includes('ADMIN'));
  });

  test('a senior does not see themselves in their own team list', () => {
    assert.ok(!descendantsOf('S1', org).includes('S1'));
  });

  test('an employee with no reports sees nobody', () => {
    assert.deepEqual(descendantsOf('E2', org), []);
  });

  test('does not hang if a malformed cycle reaches this far', () => {
    // Import rejects cycles long before this, but a walk that can hang is
    // not acceptable in code that runs on every team-list request.
    const bad = tree([['A', 'B'], ['B', 'A']]);
    const out = descendantsOf('A', bad);
    assert.ok(Array.isArray(out));
  });
});
