import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SlicerClient } from '../src/index.js';

describe('mutable VM tags', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  it('gets, adds, removes, and replaces tags by canonical hostname', async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        requests.push({
          method: req.method ?? '',
          path: req.url ?? '',
          ...(chunks.length > 0 && { body: JSON.parse(Buffer.concat(chunks).toString()) }),
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ hostname: 'demo-1', tags: ['name=builder', 'role=build'] }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const client = new SlicerClient({ baseURL: `http://127.0.0.1:${port}` });
    const vm = client.vms.attach('demo', 'demo-1');

    await expect(vm.getTags()).resolves.toEqual(['name=builder', 'role=build']);
    await expect(vm.addTags('role=build')).resolves.toContain('role=build');
    await expect(vm.removeTags('old')).resolves.toContain('role=build');
    await expect(vm.replaceTags([])).resolves.toContain('name=builder');

    expect(requests).toEqual([
      { method: 'GET', path: '/vm/demo-1/tags' },
      { method: 'PATCH', path: '/vm/demo-1/tags', body: { add: ['role=build'] } },
      { method: 'PATCH', path: '/vm/demo-1/tags', body: { remove: ['old'] } },
      { method: 'PATCH', path: '/vm/demo-1/tags', body: { replace: [] } },
    ]);
  });
});
