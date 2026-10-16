import { TEMENOS_RELAY_HEADER, TEMENOS_RELAY_PATH, TEMENOS_ROUTES } from './temenos-transport';

/** Only the verifier's four network dependencies receive this fetch. */
export function createTemenosFetch(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    // Compare the original URL, not a normalization that could erase credentials,
    // dot segments, query parameters or an alternate upstream.
    const route = TEMENOS_ROUTES.find(route => route.source === url && route.method === method);
    if (!route) throw new TypeError('Temenos transport route is not allowed');
    const request = new Request(input, init);
    if (request.credentials === 'include' || [...request.headers.keys()].some(name => name !== 'content-type')) {
      throw new TypeError('Temenos transport credentials or headers are not allowed');
    }
    const response = await fetchImpl(`${TEMENOS_RELAY_PATH}${route.path}`, {
      method, headers: request.headers,
      ...(method === 'POST' ? { body: await request.text() } : {}),
      signal: request.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'same-origin',
    });
    // Static hosts often return index.html with 200 for unknown routes. Never
    // treat that as evidence or silently retry the cross-origin endpoint.
    if (response.headers.get(TEMENOS_RELAY_HEADER) !== '1') {
      throw new TypeError('Temenos relay unavailable: use Vite dev/preview or a matching same-origin backend');
    }
    return response;
  };
}
