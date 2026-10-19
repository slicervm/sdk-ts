import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SlicerAPIError, SlicerClient } from '../src/index.js';

// Contract fixtures from Slicer 0.1.241: pkg/vm_fork.go and pkg/server.go.
const committed = {
  hostname: 'source-1', commit_id: 'cmt-123', status: 'committed',
  parent_status: 'stopped', mode: 'disk', tags: ['base'],
  labels: { project: 'sdk' }, cache_key: 'base-v1',
};
const forked = {
  hostname: 'child-2', source_hostname: 'source-1', commit_id: 'cmt-123',
  status: 'forked', parent_status: 'unchanged', child_status: 'running',
  mode: 'disk', persistent: false,
};

describe('released commit/fork HTTP contract', () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let server: http.Server;
  let client: SlicerClient;
  let status: number;
  let response: unknown;

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      calls.push({ method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    client = new SlicerClient({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  });

  beforeEach(() => { calls.length = 0; status = 200; response = forked; });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  it('commits explicitly without issuing shutdown, suspend, or fork requests', async () => {
    response = committed;
    const result = await client.vms.attach('group', 'source /1').commit({
      mode: 'disk', tags: ['base'], labels: { project: 'sdk' }, cacheKey: 'base-v1',
    });
    expect(calls).toEqual([{
      method: 'POST', path: '/vm/source%20%2F1/commit',
      body: { mode: 'disk', tags: ['base'], labels: { project: 'sdk' }, cache_key: 'base-v1' },
    }]);
    expect(result).toMatchObject({
      hostname: 'source-1', commitId: 'cmt-123', status: 'committed',
      parentStatus: 'stopped', mode: 'disk', tags: ['base'],
      labels: { project: 'sdk' }, cacheKey: 'base-v1',
    });
  });

  it('allows daemon defaults for a commit and maps absent optional fields', async () => {
    response = { hostname: 'source-1', commit_id: 'cmt-123', status: 'committed', mode: 'disk' };
    expect(await client.vms.attach('group', 'source-1').commit()).toMatchObject({
      hostname: 'source-1', commitId: 'cmt-123', status: 'committed', mode: 'disk',
    });
    expect(calls[0]).toEqual({ method: 'POST', path: '/vm/source-1/commit', body: undefined });
  });

  it('supports an explicit memory checkpoint', async () => {
    response = { ...committed, mode: 'memory', parent_status: 'running' };
    const result = await client.vms.attach('group', 'source-1').commit({ mode: 'memory' });
    expect(calls[0]!.body).toEqual({ mode: 'memory' });
    expect(result.mode).toBe('memory');
    expect(result.parentStatus).toBe('running');
  });

  it('forks the returned commit ID and maps child/source identity correctly', async () => {
    response = committed;
    const commit = await client.vms.attach('group', 'source-1').commit();
    response = forked;
    const result = await client.commits.fork(commit.commitId);
    expect(calls[1]).toEqual({
      method: 'POST', path: '/vm/commits/cmt-123/fork?wait=agent', body: undefined,
    });
    expect(result).toEqual({
      hostname: 'child-2', sourceHostname: 'source-1', commitId: 'cmt-123',
      status: 'forked', parentStatus: 'unchanged', childStatus: 'running', mode: 'disk', persistent: false,
    });
  });

  it('preserves explicit false and empty overrides, and sends wait=none', async () => {
    await client.commits.fork(' cmt-123 ', {
      wait: 'none', waitTimeoutSec: 1.5, persistent: false, vcpu: 2, ramBytes: 1073741824,
      network: { allow: [], drop: ['0.0.0.0/0'] }, tags: [], tagMode: 'replace', secrets: [], fixups: [],
    });
    expect(calls).toEqual([{
      method: 'POST', path: '/vm/commits/cmt-123/fork?wait=none&timeout=1.5s',
      body: { persistent: false, vcpu: 2, ram_bytes: 1073741824,
        network: { allow: [], drop: ['0.0.0.0/0'] }, tags: [], tag_mode: 'replace', secrets: [], fixups: [] },
    }]);
  });

  it('omits a zero fork timeout so the daemon uses its default', async () => {
    await client.commits.fork('cmt-123', { waitTimeoutSec: 0 });
    expect(calls[0]!.path).toBe('/vm/commits/cmt-123/fork?wait=agent');
  });

  it('maps a minimal fork response without inventing optional fields', async () => {
    response = { hostname: 'child-2', source_hostname: 'source-1', status: 'forked', mode: 'memory', persistent: true };
    expect(await client.commits.fork('cmt-123')).toEqual({
      hostname: 'child-2', sourceHostname: 'source-1', status: 'forked', mode: 'memory', persistent: true,
    });
  });

  it('deletes a commit explicitly and maps its response', async () => {
    response = { commit_id: 'cmt-123', status: 'deleted' };
    expect(await client.commits.delete('cmt-123')).toEqual({ commitId: 'cmt-123', status: 'deleted' });
    expect(calls).toEqual([{ method: 'DELETE', path: '/vm/commits/cmt-123', body: undefined }]);
  });

  it.each(['', ' ', '.', '..', 'a..b', 'a/b', 'a\\b', 'a\0b'])('rejects unsafe commit ID %j before HTTP', async (id) => {
    await expect(client.commits.fork(id)).rejects.toThrow();
    await expect(client.commits.delete(id)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('propagates daemon conflicts without automatic lifecycle changes', async () => {
    status = 409;
    response = { error: 'source VM must be stopped' };
    await expect(client.vms.attach('group', 'source-1').commit()).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(1);
    response = { error: 'commit not available' };
    await expect(client.commits.fork('cmt-123')).rejects.toBeInstanceOf(SlicerAPIError);
    expect(calls).toHaveLength(2);
  });
});
