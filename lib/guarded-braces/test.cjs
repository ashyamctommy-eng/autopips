'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const braces = require('./index.cjs');

test('preserves compilation and expansion used by Tailwind and globbing', () => {
  assert.deepEqual(braces('src/**/*.{ts,tsx}'), ['src/**/*.(ts|tsx)']);
  assert.deepEqual(braces.expand('a/{b,c}/d'), ['a/b/d', 'a/c/d']);
  assert.deepEqual(braces.expand('{1..5..2}'), ['1', '3', '5']);
  assert.deepEqual(braces.expand('{01..03}'), ['01', '02', '03']);
  assert.deepEqual(braces.expand('{a,{b,c}}'), ['a', 'b', 'c']);
  assert.deepEqual(braces(['a/{x,y}', 'a/x'], { expand: true, nodupes: true }), ['a/x', 'a/y']);
  assert.deepEqual(braces.expand('{,a,a}', { nodupes: true, noempty: true }), ['a']);
  assert.equal(braces.stringify(braces.parse('a/{b,c}/d')), 'a/{b,c}/d');
  assert.deepEqual(braces.expand('${x,y}'), ['${x,y}']);
  assert.deepEqual(braces.expand('a/{b'), ['a/{b']);
  assert.deepEqual(braces.expand('{1..3,x}'), ['1..3', 'x']);
  assert.deepEqual(braces.expand('a\\{b,c\\}', { keepEscaping: true }), ['a\\{b,c\\}']);
});

test('all string entry points reject deep braces, parentheses, mixed and unclosed blocks', () => {
  const patterns = [
    '{'.repeat(3000) + 'a,b' + '}'.repeat(3000),
    '('.repeat(3000) + 'x' + ')'.repeat(3000),
    '{('.repeat(1000) + 'x' + ')}'.repeat(1000),
    '{'.repeat(3000),
    '('.repeat(3000),
    '${'.repeat(1000) + 'x' + '}'.repeat(1000),
    '{'.repeat(33) + 'a,b' + '}'.repeat(33)
  ];
  for (const pattern of patterns) {
    for (const method of [braces, braces.create, braces.parse, braces.compile, braces.expand, braces.stringify]) {
      for (const options of [{}, { maxDepth: Infinity, rangeLimit: false }, { maxDepth: false }]) {
        assert.throws(() => method(pattern, options), error =>
          error instanceof SyntaxError && /nesting depth/.test(error.message));
      }
    }
  }
  // Inert escaped/quoted/bracketed braces do not increase AST depth.
  assert.doesNotThrow(() => braces.parse('\\{'.repeat(100)));
  assert.doesNotThrow(() => braces.parse('"' + '{'.repeat(100) + '"'));
  assert.doesNotThrow(() => braces.parse('[' + '{'.repeat(100) + ']'));
  assert.doesNotThrow(() => braces.expand('{'.repeat(32) + 'a,b' + '}'.repeat(32)));
});

test('recursive walkers and their direct module entry points reject unsafe ASTs', () => {
  const methods = [
    braces.compile, braces.expand, braces.stringify,
    require('./lib/compile.cjs'), require('./lib/expand.cjs'), require('./lib/stringify.cjs')
  ];
  const cycle = { type: 'root', nodes: [] };
  cycle.nodes.push(cycle);
  const parentCycle = { type: 'root', nodes: [] };
  parentCycle.parent = parentCycle;
  let deep = { type: 'text', value: 'x' };
  for (let i = 0; i < 10000; i++) deep = { type: 'root', nodes: [deep] };
  const wide = { type: 'root', nodes: Array.from({ length: 10003 }, () => ({ value: 'x' })) };
  const wrongParent = { type: 'root', nodes: [{ type: 'text', value: 'x', parent: {} }] };
  for (const ast of [cycle, parentCycle, deep, wide, wrongParent]) {
    for (const method of methods) assert.throws(() => method(ast), SyntaxError);
  }
});

test('keeps upstream length and range limits', () => {
  assert.throws(() => braces.parse('x'.repeat(10001), { maxLength: Infinity }), SyntaxError);
  assert.throws(() => braces.expand('{1..100000}'), /range limit/);
});