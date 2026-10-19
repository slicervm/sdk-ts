import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SlicerClient, type RestoreOptions, type VM } from '../src/index.js';

describe('restore HTTP contract', () => {
  let server: http.Server;
  let vm: VM;
  let status: number;
  const calls: Array<{ method: string; path: string; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push({ method: req.method!, path: req.url!, body: Buffer.concat(chunks).toString() });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { status: 'restored' } : { error: 'already running' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new SlicerClient({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    vm = client.vms.attach('group', 'vm /1');
  });
  beforeEach(() => { calls.length = 0; status = 200; });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  it.each<[string, RestoreOptions | undefined, string]>([
    ['no options', undefined, ''],
    ['timeout without wait', { timeoutSec: 60 }, ''],
    ['omitted timeout', { wait: 'agent' }, '?wait=agent'],
    ['zero timeout', { wait: 'agent', timeoutSec: 0 }, '?wait=agent'],
    ['negative timeout', { wait: 'agent', timeoutSec: -1 }, '?wait=agent'],
    ['positive timeout', { wait: 'agent', timeoutSec: 60 }, '?wait=agent&timeout=60s'],
    ['fractional timeout', { wait: 'agent', timeoutSec: 1.5 }, '?wait=agent&timeout=1.5s'],
  ])('%s uses Go SDK query semantics', async (_name, opts, query) => {
    await vm.restore(opts);
    expect(calls).toEqual([{ method: 'POST', path: `/vm/vm%20%2F1/restore${query}`, body: '' }]);
  });

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite wait timeout %s before HTTP', async timeoutSec => {
    await expect(vm.restore({ wait: 'agent', timeoutSec })).rejects.toThrow('must be finite');
    expect(calls).toHaveLength(0);
  });

  it('preserves daemon errors without retrying restore', async () => {
    status = 409;
    await expect(vm.restore({ wait: 'agent', timeoutSec: 0 })).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(1);
  });
});
