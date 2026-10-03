'use strict';

const utils = require('./utils.cjs');
const { checkAst } = require('./guard.cjs');

module.exports = (ast, options = {}) => {
  checkAst(ast);
  const stringify = (node, parent = {}) => {
    const invalidBlock = options.escapeInvalid && utils.isInvalidBrace(parent);
    const invalidNode = node.invalid === true && options.escapeInvalid === true;
    let output = '';
    if (node.value) {
      if ((invalidBlock || invalidNode) && utils.isOpenOrClose(node)) return '\\' + node.value;
      return node.value;
    }
    if (node.nodes) {
      for (const child of node.nodes) output += stringify(child);
    }
    return output;
  };
  return stringify(ast);
};