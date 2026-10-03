'use strict';

const stringify = require('./stringify.cjs');
const { checkBlockDepth } = require('./guard.cjs');
const {
  MAX_LENGTH, CHAR_BACKSLASH, CHAR_BACKTICK, CHAR_COMMA, CHAR_DOT,
  CHAR_LEFT_PARENTHESES, CHAR_RIGHT_PARENTHESES, CHAR_LEFT_CURLY_BRACE,
  CHAR_RIGHT_CURLY_BRACE, CHAR_LEFT_SQUARE_BRACKET, CHAR_RIGHT_SQUARE_BRACKET,
  CHAR_DOUBLE_QUOTE, CHAR_SINGLE_QUOTE, CHAR_NO_BREAK_SPACE, CHAR_ZERO_WIDTH_NOBREAK_SPACE
} = require('./constants.cjs');

const parse = (input, options = {}) => {
  if (typeof input !== 'string') throw new TypeError('Expected a string');
  const opts = options || {};
  const max = typeof opts.maxLength === 'number' ? Math.min(MAX_LENGTH, opts.maxLength) : MAX_LENGTH;
  if (input.length > max) throw new SyntaxError(`Input length (${input.length}), exceeds max characters (${max})`);
  const ast = { type: 'root', input, nodes: [] };
  const stack = [ast];
  let block = ast;
  let prev = ast;
  let brackets = 0;
  const length = input.length;
  let index = 0;
  let depth = 0;
  let value;
  const advance = () => input[index++];
  const push = node => {
    if (node.type === 'text' && prev.type === 'dot') prev.type = 'text';
    if (prev && prev.type === 'text' && node.type === 'text') {
      prev.value += node.value;
      return;
    }
    block.nodes.push(node);
    node.parent = block;
    node.prev = prev;
    prev = node;
    return node;
  };
  push({ type: 'bos' });
  while (index < length) {
    block = stack[stack.length - 1];
    value = advance();
    if (value === CHAR_ZERO_WIDTH_NOBREAK_SPACE || value === CHAR_NO_BREAK_SPACE) continue;
    if (value === CHAR_BACKSLASH) {
      push({ type: 'text', value: (options.keepEscaping ? value : '') + advance() });
      continue;
    }
    if (value === CHAR_RIGHT_SQUARE_BRACKET) {
      push({ type: 'text', value: '\\' + value });
      continue;
    }
    if (value === CHAR_LEFT_SQUARE_BRACKET) {
      brackets++;
      let next;
      while (index < length && (next = advance())) {
        value += next;
        if (next === CHAR_LEFT_SQUARE_BRACKET) {
          brackets++;
          continue;
        }
        if (next === CHAR_BACKSLASH) {
          value += advance();
          continue;
        }
        if (next === CHAR_RIGHT_SQUARE_BRACKET) {
          brackets--;
          if (brackets === 0) break;
        }
      }
      push({ type: 'text', value });
      continue;
    }
    if (value === CHAR_LEFT_PARENTHESES) {
      checkBlockDepth(stack);
      block = push({ type: 'paren', nodes: [] });
      stack.push(block);
      push({ type: 'text', value });
      continue;
    }
    if (value === CHAR_RIGHT_PARENTHESES) {
      if (block.type !== 'paren') {
        push({ type: 'text', value });
        continue;
      }
      block = stack.pop();
      push({ type: 'text', value });
      block = stack[stack.length - 1];
      continue;
    }
    if (value === CHAR_DOUBLE_QUOTE || value === CHAR_SINGLE_QUOTE || value === CHAR_BACKTICK) {
      const open = value;
      let next;
      if (options.keepQuotes !== true) value = '';
      while (index < length && (next = advance())) {
        if (next === CHAR_BACKSLASH) {
          value += next + advance();
          continue;
        }
        if (next === open) {
          if (options.keepQuotes === true) value += next;
          break;
        }
        value += next;
      }
      push({ type: 'text', value });
      continue;
    }
    if (value === CHAR_LEFT_CURLY_BRACE) {
      checkBlockDepth(stack);
      depth++;
      const dollar = prev.value && prev.value.slice(-1) === '$' || block.dollar === true;
      const brace = {
        type: 'brace', open: true, close: false, dollar, depth, commas: 0, ranges: 0, nodes: []
      };
      block = push(brace);
      stack.push(block);
      push({ type: 'open', value });
      continue;
    }
    if (value === CHAR_RIGHT_CURLY_BRACE) {
      if (block.type !== 'brace') {
        push({ type: 'text', value });
        continue;
      }
      const type = 'close';
      block = stack.pop();
      block.close = true;
      push({ type, value });
      depth--;
      block = stack[stack.length - 1];
      continue;
    }
    if (value === CHAR_COMMA && depth > 0) {
      if (block.ranges > 0) {
        block.ranges = 0;
        const open = block.nodes.shift();
        block.nodes = [open, { type: 'text', value: stringify(block) }];
      }
      push({ type: 'comma', value });
      block.commas++;
      continue;
    }
    if (value === CHAR_DOT && depth > 0 && block.commas === 0) {
      const siblings = block.nodes;
      if (depth === 0 || siblings.length === 0) {
        push({ type: 'text', value });
        continue;
      }
      if (prev.type === 'dot') {
        block.range = [];
        prev.value += value;
        prev.type = 'range';
        if (block.nodes.length !== 3 && block.nodes.length !== 5) {
          block.invalid = true;
          block.ranges = 0;
          prev.type = 'text';
          continue;
        }
        block.ranges++;
        block.args = [];
        continue;
      }
      if (prev.type === 'range') {
        siblings.pop();
        const before = siblings[siblings.length - 1];
        before.value += prev.value + value;
        prev = before;
        block.ranges--;
        continue;
      }
      push({ type: 'dot', value });
      continue;
    }
    push({ type: 'text', value });
  }
  do {
    block = stack.pop();
    if (block.type !== 'root') {
      block.nodes.forEach(node => {
        if (!node.nodes) {
          if (node.type === 'open') node.isOpen = true;
          if (node.type === 'close') node.isClose = true;
          if (!node.nodes) node.type = 'text';
          node.invalid = true;
        }
      });
      const parent = stack[stack.length - 1];
      const index = parent.nodes.indexOf(block);
      // Reparent flattened nodes so hardened AST validation remains correct.
      for (const node of block.nodes) node.parent = parent;
      parent.nodes.splice(index, 1, ...block.nodes);
    }
  } while (stack.length > 0);
  push({ type: 'eos' });
  return ast;
};

module.exports = parse;