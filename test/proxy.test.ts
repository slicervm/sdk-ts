import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ProxySecretOAuthClaude, SlicerClient } from '../src/index.js';

const ZERO_TIME = '0001-01-01T00:00:00Z';

describe('proxy admin API', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  async function start(
    handler: (req: http.IncomingMessage, res: http.ServerResponse, body: unknown) => void,
  ): Promise<SlicerClient> {
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        handler(req, res, body);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return new SlicerClient({ baseURL: `http://127.0.0.1:${port}` });
  }

  it('creates secrets with type and force, and maps lifecycle timestamps', async () => {
    const requests: string[] = [];
    const client = await start((req, res, body) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.method === 'POST' && req.url === '/proxy/v1/secrets') {
        expect(body).toEqual({
          name: 'claude',
          host: 'api.anthropic.com',
          value: '{"accessToken":"a","refreshToken":"r"}',
          type: 'oauth-claude',
          force: true,
        });
        res.end('{}');
      } else if (req.method === 'GET' && req.url === '/proxy/v1/secrets') {
        res.end(
          JSON.stringify([
            {
              name: 'claude',
              host: 'api.anthropic.com',
              type: 'oauth-claude',
              created_at: '2026-09-01T10:00:00Z',
              updated_at: '2026-09-02T10:00:00Z',
              adopted_at: '2026-09-01T10:00:00Z',
              refreshed_at: ZERO_TIME,
            },
            { name: 'legacy', host: 'example.com', created_at: '2026-08-01T10:00:00Z', updated_at: ZERO_TIME },
          ]),
        );
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });

    await client.proxy.secrets.create({
      name: 'claude',
      host: 'api.anthropic.com',
      type: ProxySecretOAuthClaude,
      value: '{"accessToken":"a","refreshToken":"r"}',
      force: true,
    });
    const secrets = await client.proxy.secrets.list();
    expect(secrets).toEqual([
      {
        name: 'claude',
        host: 'api.anthropic.com',
        type: 'oauth-claude',
        createdAt: '2026-09-01T10:00:00Z',
        updatedAt: '2026-09-02T10:00:00Z',
        adoptedAt: '2026-09-01T10:00:00Z',
      },
      { name: 'legacy', host: 'example.com', createdAt: '2026-08-01T10:00:00Z' },
    ]);
    expect(requests).toEqual(['POST /proxy/v1/secrets', 'GET /proxy/v1/secrets']);
  });

  it('sends and maps ports on allow rules', async () => {
    const requests: string[] = [];
    const client = await start((req, res, body) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.method === 'POST' && req.url === '/proxy/v1/allows') {
        expect(body).toEqual({
          client: 'web-1',
          host: 'registry.example.com',
          methods: ['GET'],
          ports: [5000, 8443],
          ttl_seconds: 600,
        });
        res.end(
          JSON.stringify({
            host: 'registry.example.com',
            methods: ['GET'],
            ports: [5000, 8443],
            expires: '2026-09-01T10:10:00Z',
          }),
        );
      } else if (req.method === 'GET' && req.url === '/proxy/v1/clients/web-1') {
        res.end(
          JSON.stringify([
            { host: 'registry.example.com', methods: ['GET'], ports: [5000, 8443], expires: ZERO_TIME },
            { host: 'github.com', ports: [], expires: ZERO_TIME },
          ]),
        );
      } else if (req.method === 'POST' && req.url === '/proxy/v1/allows/revoke') {
        expect(body).toEqual({
          client: 'web-1',
          host: 'registry.example.com',
          methods: ['GET'],
          ports: [5000, 8443],
        });
        res.end('{}');
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });

    const rule = await client.proxy.allows.add({
      client: 'web-1',
      host: 'registry.example.com',
      methods: ['GET'],
      ports: [5000, 8443],
      ttlSeconds: 600,
    });
    expect(rule).toEqual({
      host: 'registry.example.com',
      methods: ['GET'],
      ports: [5000, 8443],
      expires: '2026-09-01T10:10:00Z',
    });
    expect(await client.proxy.clients.rules('web-1')).toEqual([
      { host: 'registry.example.com', methods: ['GET'], ports: [5000, 8443] },
      { host: 'github.com' },
    ]);
    await client.proxy.allows.removeByTuple({
      client: 'web-1',
      host: 'registry.example.com',
      methods: ['GET'],
      ports: [5000, 8443],
    });
    expect(requests).toEqual([
      'POST /proxy/v1/allows',
      'GET /proxy/v1/clients/web-1',
      'POST /proxy/v1/allows/revoke',
    ]);
  });
});
