import { LOCAL_CHAIN_ENDPOINTS } from './wallet-input';

// What the local chain itself reports, read from Node, never from the page under test: lace-platform's
// `compose/midnight.yml` node (JSON-RPC over HTTP on the WebSocket port) and indexer (GraphQL).

const NODE_RPC = LOCAL_CHAIN_ENDPOINTS.nodeAddress;
const INDEXER = LOCAL_CHAIN_ENDPOINTS.indexerAddress;

async function post(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
  return response.json();
}

async function rpc(method: string): Promise<unknown> {
  const reply = await post(NODE_RPC, { id: 1, jsonrpc: '2.0', method, params: [] }) as { result?: unknown; error?: unknown };
  if (reply.error !== undefined) throw new Error(`${method} failed`);
  return reply.result;
}

/** The node's best block number. */
export async function nodeBlockNumber(): Promise<number> {
  const header = await rpc('chain_getHeader') as { number?: unknown };
  const value = Number.parseInt(String(header?.number), 16);
  if (!Number.isInteger(value)) throw new Error('chain_getHeader returned no block number');
  return value;
}

/** How many extrinsics wait in the node's transaction pool. */
export async function nodePendingExtrinsics(): Promise<number> {
  const pending = await rpc('author_pendingExtrinsics');
  if (!Array.isArray(pending)) throw new Error('author_pendingExtrinsics returned no list');
  return pending.length;
}

/** How many transactions with this hash the indexer holds. */
export async function indexedTransactions(hash: string): Promise<number> {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Expected a 64-character transaction hash');
  const reply = await post(INDEXER, {
    query: 'query ($hash: HexEncoded!) { transactions(offset: { hash: $hash }) { hash } }',
    variables: { hash },
  }) as { data?: { transactions?: unknown }; errors?: unknown };
  if (reply.errors !== undefined || !Array.isArray(reply.data?.transactions)) throw new Error('The indexer refused the transaction query');
  return reply.data.transactions.length;
}

/** Waits until the node has produced `blocks` more blocks. */
export async function waitForBlocks(blocks: number, limitMs: number): Promise<{ from: number; to: number }> {
  const from = await nodeBlockNumber();
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    const to = await nodeBlockNumber();
    if (to >= from + blocks) return { from, to };
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error(`The local node produced fewer than ${blocks} blocks within ${limitMs} ms`);
}
