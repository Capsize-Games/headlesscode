"use strict";
async function main(input) {
  const a = input.a;
  const b = input.b;
  return { marker: "EXTENSION_NODE_CHECK_OK", sum: a + b };
}
module.exports = main;
module.exports.default = main;
module.exports.run = main;
module.exports.handler = main;
module.exports.invoke = main;
