'use strict';

const MAX_BLOCK_DEPTH = 32;
const MAX_AST_DEPTH = MAX_BLOCK_DEPTH + 2;
const MAX_NODES = 10002;

function checkBlockDepth(stack) {
  if (stack.length > MAX_BLOCK_DEPTH) {
    throw new SyntaxError('Brace pattern exceeds maximum nesting depth (32)');
  }
}

// Validate without recursion before any recursive AST walker can run.
function checkAst(ast) {
  const ancestors = new Set();
  for (let node = ast; node; node = node.parent) {
    if (ancestors.has(node)) throw new SyntaxError('Brace AST contains a parent cycle');
    ancestors.add(node);
    if (ancestors.size > MAX_AST_DEPTH + 1) {
      throw new SyntaxError('Brace AST exceeds maximum parent depth');
    }
  }
  const pending = [{ node: ast, depth: 0, parent: undefined }];
  const seen = new Set();
  while (pending.length) {
    const { node, depth, parent } = pending.pop();
    if (!node || typeof node !== 'object') throw new TypeError('Expected an AST node');
    if (depth > MAX_AST_DEPTH) throw new SyntaxError('Brace AST exceeds maximum nesting depth');
    if (seen.has(node)) throw new SyntaxError('Brace AST contains a cycle or shared node');
    seen.add(node);
    if (seen.size > MAX_NODES) throw new SyntaxError('Brace AST exceeds maximum node count');
    if (parent && node.parent && node.parent !== parent) {
      throw new SyntaxError('Brace AST contains an invalid parent link');
    }
    if (node.nodes !== undefined) {
      if (!Array.isArray(node.nodes)) throw new TypeError('Expected AST nodes array');
      if (node.nodes.length + pending.length + seen.size > MAX_NODES) {
        throw new SyntaxError('Brace AST exceeds maximum node count');
      }
      for (const child of node.nodes) pending.push({ node: child, depth: depth + 1, parent: node });
    }
  }
}

module.exports = { checkBlockDepth, checkAst };