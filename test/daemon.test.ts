import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SlicerClient } from '../src/index.js';

describe('SlicerClient.shutdownDaemon', () => {
  let server: http.Server | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  for (const transport of ['TCP', 'Unix socket']) {
    it(`requests authenticated 202 acceptance over ${transport}`, async () => {
      let observed: { method?: string; url?: string; token?: string; agent?: string; body: string };
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => {
          observed = {
            method: req.method,
            url: req.url,
            token: req.headers.authorization,
            agent: req.headers['user-agent'],
            body,
          };
          res.writeHead(202, { 'Content-Length': '0' });
          res.end();
        });
      });
      let baseURL: string;
      if (transport === 'Unix socket') {
        directory = await mkdtemp(path.join(os.tmpdir(), 'slicer-sdk-daemon-'));
        baseURL = path.join(directory, 'daemon.sock');
        await new Promise<void>((resolve) => server!.listen(baseURL, resolve));
      } else {
        await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
        baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      }
      const client = new SlicerClient({ baseURL, token: 'test-token', userAgent: 'daemon-test' });
      await expect(client.shutdownDaemon()).resolves.toBeUndefined();
      expect(observed!).toEqual({
        method: 'POST', url: '/daemon/shutdown', token: 'Bearer test-token',
        agent: 'daemon-test', body: '',
      });
    });
  }

  for (const status of [200, 401, 503]) {
    it(`rejects ${status} with the existing API error type`, async () => {
      server = http.createServer((_req, res) => {
        res.writeHead(status);
        res.end('not accepted');
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const client = new SlicerClient({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
      await expect(client.shutdownDaemon()).rejects.toMatchObject({
        name: 'SlicerAPIError', method: 'POST', path: '/daemon/shutdown', status,
        body: 'not accepted',
      });
    });
  }

  it('cancels an in-flight acceptance wait', async () => {
    const controller = new AbortController();
    let received!: () => void;
    const requestReceived = new Promise<void>((resolve) => { received = resolve; });
    server = http.createServer(() => received());
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const client = new SlicerClient({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    const pending = client.shutdownDaemon({ signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await requestReceived;
    controller.abort();
    await rejected;
  });

  it('honours an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new SlicerClient({ baseURL: 'http://127.0.0.1:1' });
    await expect(client.shutdownDaemon({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
