import { defineConfig } from 'vite';
import { sponsorRelayPlugin } from './sponsor-relay';
import { verifierBrowserPlugin } from './verifier-browser';
import { temenosRelayPlugin } from './temenos-relay';

export default defineConfig(({ mode }) => ({
  // The fee sponsor relay on /sponsor, which reads SPONSOR_URL and
  // SPONSOR_API_KEY in this Node process. Only VITE_ variables reach the
  // browser bundle.
  plugins: [sponsorRelayPlugin(), verifierBrowserPlugin(), temenosRelayPlugin()],
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
  // The regression build adds a probe entry using the same production config.
  // It is absent from ordinary application builds.
  ...(mode === 'browser-runtime' ? { build: { rolldownOptions: { input: {
    app: 'index.html', runtimeProbe: 'tests/e2e/runtime-probe.html',
  } } } } : {}),
}));
