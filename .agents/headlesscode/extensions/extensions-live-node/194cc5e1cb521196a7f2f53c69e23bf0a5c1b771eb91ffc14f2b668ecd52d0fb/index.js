async function main(input) {
  const a = input && input.a;
  const b = input && input.b;
  return { marker: "EXTENSION_NODE_CHECK_OK", sum: a + b };
}
module.exports = main;
module.exports.default = main;
module.exports.handler = main;
module.exports.run = main;
