/**
 * A test client that speaks real HTTP.
 *
 * Fastify had app.inject(), which drove the router in-process without ever
 * binding a port. Express has no equivalent, and rather than add supertest
 * this starts the actual server on an ephemeral port and uses fetch — which
 * is closer to the truth anyway: it exercises body parsing, content-type
 * negotiation, the error handler and the socket, none of which inject() did.
 *
 * The returned object keeps inject()'s shape on purpose, so every assertion
 * in gate1.mjs stayed byte-identical across the migration. If the numbers
 * still come out the same, the rewrite did not change behaviour.
 */

import { once } from 'node:events';
import { buildApp } from '../src/app.js';

export async function startTestServer() {
  const app = buildApp({ logger: false });
  const server = app.listen(0);
  await once(server, 'listening');

  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,

    async inject({ method = 'GET', url, payload, headers = {} }) {
      const isRaw = typeof payload === 'string';
      const res = await fetch(base + url, {
        method,
        headers: {
          ...(payload !== undefined
            ? { 'content-type': isRaw ? 'text/csv' : 'application/json' }
            : {}),
          ...headers,
        },
        body:
          payload === undefined ? undefined : isRaw ? payload : JSON.stringify(payload),
      });

      const body = await res.text();
      return {
        statusCode: res.status,
        headers: Object.fromEntries(res.headers),
        body,
        json: () => JSON.parse(body),
      };
    },

    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
