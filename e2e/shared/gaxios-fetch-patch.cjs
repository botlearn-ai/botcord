// Patch gaxios to use Node.js built-in fetch instead of node-fetch.
// Fixes "Cannot convert undefined or null to object" error caused by
// gaxios trying to dynamically import node-fetch in pnpm environments
// where module resolution fails due to strict isolation.
//
// This is loaded via NODE_OPTIONS="--require /path/to/gaxios-fetch-patch.cjs"

const Module = require('module');
const originalLoad = Module._load;

Module._load = function(request, parent, isMain) {
  const mod = originalLoad.call(this, request, parent, isMain);

  // Intercept gaxios module load and patch _defaultAdapter
  if (request.includes('gaxios') && mod.Gaxios && !mod.__fetchPatched) {
    const Gaxios = mod.Gaxios;
    const origAdapter = Gaxios.prototype._defaultAdapter;
    Gaxios.prototype._defaultAdapter = async function(config) {
      if (!config.fetchImplementation && !this.defaults?.fetchImplementation) {
        config.fetchImplementation = globalThis.fetch;
      }
      return origAdapter.call(this, config);
    };
    mod.__fetchPatched = true;
  }

  return mod;
};
