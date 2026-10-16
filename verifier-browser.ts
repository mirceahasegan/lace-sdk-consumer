import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

const packagePath = '/node_modules/@input-output-hk/temenos-attestation-verifier/dist/';
const rules = [
  {
    file: 'phases/evidence.js',
    sha256: 'ad5c0f7f719e600588393387022e67a9672515dc679314a22123148d37db8c20',
    start: '    #insecureFetchInit() {',
    end: '\n}\n/**',
    replacement: `    #insecureFetchInit() {
        throw new AttestationVerificationError('obtain-evidence', 'Insecure Node TLS is disabled in this browser consumer');
    }`,
  },
  {
    file: 'phases/channel/nodeTlsChannelBinder.js',
    sha256: '3f1f8ab7ab7de3071de76c86426985fcfeec8993d318b9276e9d70a3f3661328',
    start: 'async function loadNodeModules() {',
    end: '\nconst isIpLiteral',
    replacement: `async function loadNodeModules() {
    throw new ChannelBindingError('Node TLS channel binding is disabled in this browser consumer; use AKX');
}`,
  },
];

// Refuse optional Node transports: their catch would swallow an undici shim
// error and fall back to ordinary fetch. Keep browser AKX and trust checks intact.
// Pin bytes so a verifier update requires reviewing this integration.
export function verifierBrowserPlugin(): Plugin {
  return {
    name: 'temenos-browser-node-refusal',
    enforce: 'pre',
    transform(code, id, options) {
      if (options?.ssr) return;
      const rule = rules.find(rule => id.replaceAll('\\', '/').endsWith(packagePath + rule.file));
      if (!rule) return;
      if (createHash('sha256').update(code).digest('hex') !== rule.sha256) {
        throw new Error(`Review browser integration for changed verifier module: ${rule.file}`);
      }
      const start = code.indexOf(rule.start);
      const end = code.indexOf(rule.end, start);
      if (start < 0 || end < 0) throw new Error(`Missing verifier Node boundary: ${rule.file}`);
      return { code: code.slice(0, start) + rule.replacement + code.slice(end), map: null };
    },
  };
}
