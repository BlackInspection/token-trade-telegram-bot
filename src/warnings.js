// Import this first: hides the node:sqlite ExperimentalWarning and the punycode
// deprecation pulled in by @solana/web3.js deps. Other warnings still print.
const original = process.emitWarning;
process.emitWarning = function patchedEmitWarning(warning, ...args) {
  const opt = args[0];
  const type = typeof opt === 'string' ? opt : opt?.type;
  const code = typeof opt === 'object' ? opt?.code : args[1];
  const msg = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (type === 'ExperimentalWarning' && /sqlite/i.test(msg)) return;
  if (code === 'DEP0040' || /punycode/.test(msg)) return;
  return original.call(process, warning, ...args);
};
