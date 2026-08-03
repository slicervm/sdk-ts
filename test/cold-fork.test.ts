import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SlicerClient } from '../src/index.js';

describe('cold fork workflow', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  it('commits, lists, forks, describes, and deletes', async () => {
    const requests: string[] = [];
    server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        if (req.method === 'POST' && req.url === '/vm/demo-1/commit') {
          expect(body).toEqual({ tags: ['base', 'test'], cache_key: 'cache-v1' });
          res.end(
            JSON.stringify({
              hostname: 'demo-1',
              commit_id: 'cmt-demo',
              status: 'committed',
              parent_status: 'stopped',
              mode: 'disk',
              tags: ['base', 'test'],
              cache_key: 'cache-v1',
            }),
          );
        } else if (
          req.method === 'GET' &&
          req.url === '/vm/commits?tag=base&tag=test&cache_key=cache-v1'
        ) {
          res.end(
            JSON.stringify([
              {
                commit_id: 'cmt-demo',
                source_hostname: 'demo-1',
                source_host_group: 'demo',
                created_at: '2026-07-29T12:00:00Z',
                mode: 'disk',
                cache_key: 'cache-v1',
              },
            ]),
          );
        } else if (
          req.method === 'POST' &&
          req.url === '/vm/commits/cmt-demo/fork?wait=agent&timeout=45s'
        ) {
          expect(body).toEqual({ hostname: 'demo-2', network: { allow: [] } });
          res.end(
            JSON.stringify({
              hostname: 'demo-1',
              commit_id: 'cmt-demo',
              child_hostname: 'demo-2',
              status: 'forked',
              child_status: 'running',
              mode: 'disk',
            }),
          );
        } else if (req.method === 'GET' && req.url === '/vm/demo-2') {
          res.end(
            JSON.stringify({
              hostname: 'demo-2',
              hostgroup: 'demo',
              ip: '169.254.1.2',
              created_at: '',
              parent_commit_id: 'cmt-demo',
              network: {
                mode: 'isolated',
                policy_source: 'vm',
                host_group: { allow: ['10.0.0.0/8'], drop: [] },
                override: { allow: [] },
                effective: { allow: [], drop: [] },
              },
            }),
          );
        } else if (req.method === 'DELETE' && req.url === '/vm/commits/cmt-demo') {
          res.end(JSON.stringify({ commit_id: 'cmt-demo', status: 'deleted' }));
        } else {
          res.statusCode = 404;
          res.end('{}');
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const client = new SlicerClient({ baseURL: `http://127.0.0.1:${port}` });
    const source = client.vms.attach('demo', 'demo-1');

    const committed = await source.commit({ tags: ['base', 'test'], cacheKey: ' cache-v1 ' });
    expect(committed.commitId).toBe('cmt-demo');
    expect((await client.commits.list({ tags: ['base', 'test'], cacheKey: 'cache-v1' }))[0])
      .toMatchObject({ commitId: 'cmt-demo', sourceHostGroup: 'demo' });
    const child = await committed.fork('demo-2', {
      waitTimeoutSec: 45,
      network: { allow: [] },
    });
    expect(child.hostname).toBe('demo-2');
    const description = await child.describe();
    expect(description.parentCommitId).toBe('cmt-demo');
    expect(description.network.override?.allow).toEqual([]);
    await expect(client.commits.delete('cmt-demo')).resolves.toEqual({
      commitId: 'cmt-demo',
      status: 'deleted',
    });
    expect(requests).toHaveLength(5);
  });

  it.each(['', '../commit', 'commit/child', 'commit\\child'])(
    'rejects invalid commit ID %j before a request',
    async (commitId) => {
      const client = new SlicerClient({ baseURL: 'http://127.0.0.1:1' });
      await expect(client.commits.delete(commitId)).rejects.toThrow(/invalid commit ID/);
      await expect(client.commits.fork(commitId)).rejects.toThrow(/invalid commit ID/);
    },
  );
});
