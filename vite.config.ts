import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { sponsorRelayPlugin } from './sponsor-relay';
import { verifierBrowserPlugin } from './verifier-browser';
import { temenosRelayPlugin } from './temenos-relay';

export default defineConfig(({ mode }) => ({
  plugins: [
    // @laceio/cardano reads the Buffer global, and its dependencies read the
    // global and process globals and import Node's events module when they
    // load (the SDK's Midnight guide, "Install").
    nodePolyfills({ globals: { Buffer: true, global: true, process: true } }),
    // The fee sponsor relay on /sponsor, which reads SPONSOR_URL and
    // SPONSOR_API_KEY in this Node process. Only VITE_ variables reach the
    // browser bundle.
    sponsorRelayPlugin(),
    verifierBrowserPlugin(),
    temenosRelayPlugin(),
  ],
  // assert's browser util dependency reads this at module initialization.
  // Disable Node debug logging explicitly; never expose the host environment.
  define: { 'process.env.NODE_DEBUG': '""' },
  resolve: {
    alias: [
      // Midnight DUST serialization calls @subsquid SCALE's real assertions.
      { find: /^(?:node:)?assert$/, replacement: 'assert/' },
      // @cardano-sdk CJS internals use require("buffer")
      { find: 'buffer', replacement: 'buffer/' },
    ],
  },
  optimizeDeps: {
    include: ['buffer', 'assert'],
    // wasm-bindgen's JS glue imports its WASM, whose host imports point back
    // into that glue (ledger also uses #self in snippets). Prebundling only
    // the JS splits this cycle and calls __wbindgen_start before initialization.
    // Let Vite's native WASM pipeline load each package as one module graph.
    exclude: [
      '@midnight-ntwrk/ledger-v8',
      '@midnight-ntwrk/onchain-runtime-v3',
      '@midnight-ntwrk/zkir-v2',
    ],
    rolldownOptions: { plugins: [verifierBrowserPlugin()] },
  },
  // `@laceio/sdk/midnight` names its Worker-mode SharedWorker script, so a
  // production build bundles that worker even though this app runs the
  // engine on the page. The ledger's WebAssembly uses top-level await, which
  // only the ES worker format supports (the SDK's Midnight guide, "Worker mode").
  worker: { format: 'es' },
  // The regression build adds a probe entry using the same production config.
  // It is absent from ordinary application builds.
  ...(mode === 'browser-runtime' ? { build: { rolldownOptions: { input: {
    app: 'index.html', runtimeProbe: 'tests/e2e/runtime-probe.html',
  } } } } : {}),
}));
