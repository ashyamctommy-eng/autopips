'use strict';

const stringify = require('./lib/stringify.cjs');
const compile = require('./lib/compile.cjs');
const expand = require('./lib/expand.cjs');
const parse = require('./lib/parse.cjs');

const braces = (input, options = {}) => {
  let output = [];
  if (Array.isArray(input)) {
    for (const pattern of input) {
      const result = braces.create(pattern, options);
      if (Array.isArray(result)) output.push(...result);
      else output.push(result);
    }
  } else {
    output = [].concat(braces.create(input, options));
  }
  if (options && options.expand === true && options.nodupes === true) output = [...new Set(output)];
  return output;
};

braces.parse = (input, options = {}) => parse(input, options);
braces.stringify = (input, options = {}) => {
  if (typeof input === 'string') return stringify(braces.parse(input, options), options);
  return stringify(input, options);
};
braces.compile = (input, options = {}) => {
  if (typeof input === 'string') input = braces.parse(input, options);
  return compile(input, options);
};
braces.expand = (input, options = {}) => {
  if (typeof input === 'string') input = braces.parse(input, options);
  let result = expand(input, options);
  if (options.noempty === true) result = result.filter(Boolean);
  if (options.nodupes === true) result = [...new Set(result)];
  return result;
};
braces.create = (input, options = {}) => {
  if (input === '' || input.length < 3) return [input];
  return options.expand !== true ? braces.compile(input, options) : braces.expand(input, options);
};

module.exports = braces;