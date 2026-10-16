import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { nonprovingBlockedURLs } from './live/nonproving-observations.ts';

const origin = 'http://localhost:5198';
test('serialized filter blocks prover/relay/lookalikes while leaving approved HTTP and sockets unmatched', () => {
  const filter = nonprovingBlockedURLs(origin);
  const serialized = new RegExp(filter.source, filter.flags);
  for (const url of ['http://127.0.0.1:6300/version', 'ws://127.0.0.1:6300/prove', `${origin}/temenos-relay/tee_attestation/proxy`, `${origin}/%74emenos-relay/proxy`, 'wss://indexer.preview.midnight.network.evil/api', 'wss://user@indexer.preview.midnight.network/api', 'wss://indexer.preview.midnight.network:9999/api']) assert.equal(serialized.test(url), true);
  for (const url of [`${origin}/midnight`, 'ws://localhost:5198/', 'https://rpc.preview.midnight.network/', 'wss://indexer.preview.midnight.network/api/v4/graphql/ws']) assert.equal(serialized.test(url), false);
});

// Execute the installed injection in a bounded VM with a fake native socket.
// No browser, listening socket, network, wallet or large real indexer frames.
test('installed Playwright passes approved frames in browser; wildcard control routes them through binding', () => {
  const bundle = readFileSync(new URL('../node_modules/playwright-core/lib/coreBundle.js', import.meta.url), 'utf8');
  const raw = bundle.match(/source11 = `([\s\S]*?)`;\n/)?.[1];
  assert.ok(raw, 'Installed Playwright injection anchor must exist.');
  const source = runInNewContext('`' + raw + '`', {}, { timeout: 1000 });
  const fixture = (filter, url = 'wss://indexer.preview.midnight.network/api/v4/graphql/ws') => {
    let native, frames = 0, creates = 0;
    class FakeSocket {
      readyState = 1; bufferedAmount = 0; extensions = ''; protocol = '';
      constructor() { native = this; }
      send() {}
      close() {}
    }
    class FakeCloseEvent extends Event { constructor(type, options) { super(type, options); this.code = options.code; this.reason = options.reason; this.wasClean = options.wasClean; } }
    const sandbox = { module: { exports: {} }, WebSocket: FakeSocket, EventTarget, Event, MessageEvent, CloseEvent: FakeCloseEvent, URL, Uint8Array, Blob,
      crypto: { getRandomValues: bytes => bytes.fill(1) }, window: { document: { baseURI: origin } },
      __pwWebSocketBinding: request => {
        if (request.type === 'onCreate') {
          creates++;
          sandbox.__pwWebSocketDispatch({ id: request.id, type: filter.control ? 'connect' : filter.test(request.url) ? 'closePage' : 'passthrough' });
        } else if (request.type === 'onMessageFromServer') {
          frames++;
          sandbox.__pwWebSocketDispatch({ id: request.id, type: 'sendToPage', data: request.data });
        }
      },
    };
    runInNewContext(source + '\n(module.exports.inject())(globalThis);', sandbox, { timeout: 1000 });
    const socket = new sandbox.WebSocket(url);
    let delivered = 0;
    socket.onmessage = () => delivered++;
    if (native) {
      native.onopen();
      for (let i = 0; i < 500; i++) native.onmessage({ data: 'synthetic-frame' });
    }
    return { frames, delivered, creates, connected: !!native };
  };
  assert.deepEqual(fixture(nonprovingBlockedURLs(origin)), { frames: 0, delivered: 500, creates: 1, connected: true });
  const wildcard = /./; wildcard.control = true;
  assert.deepEqual(fixture(wildcard), { frames: 500, delivered: 500, creates: 1, connected: true });
  for (const url of ['ws://127.0.0.1:6300/prove', 'wss://api.proofserver.wastedp.io/prove', 'ws://localhost:5198/temenos-relay/prove']) {
    assert.deepEqual(fixture(nonprovingBlockedURLs(origin), url), { frames: 0, delivered: 0, creates: 1, connected: false });
  }
});
