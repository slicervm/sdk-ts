import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SlicerClient, type BgExecSummary } from '../src/index.js';
import type { WireVMDescription } from '../src/wire.js';

describe('guest-agent activity', () => {
  let server: http.Server | undefined;
  const marker = '2026-10-08T15:30:00.123456789Z';
  const node = {
    hostname: 'demo-1',
    hostgroup: 'demo',
    ip: '172.16.0.2',
    created_at: '2026-10-08T15:00:00Z',
  };
  const network = {
    mode: 'isolated',
    host_group: { allow: [], drop: [] },
    effective: { allow: [], drop: [] },
  };

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  async function clientFor(description: WireVMDescription): Promise<SlicerClient> {
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/vm/demo-1') {
        res.end(JSON.stringify(description));
      } else if (
        req.method === 'GET' &&
        (req.url === '/nodes' || req.url === '/hostgroup/demo/nodes')
      ) {
        res.end(JSON.stringify([node, { ...node, hostname: 'demo-2', last_agent_call: marker }]));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return new SlicerClient({ baseURL: `http://127.0.0.1:${port}` });
  }

  it('exposes last use in both list paths without fabricating an unset marker', async () => {
    const client = await clientFor({ ...node, network });
    for (const vms of [await client.vms.list(), await client.hostGroups.listVMs('demo')]) {
      expect(vms).toHaveLength(2);
      expect(vms[0]).not.toHaveProperty('lastAgentCall');
      expect(vms[1]?.lastAgentCall).toBe(marker);
      expect(vms[1]).not.toHaveProperty('last_agent_call');
    }
  });

  it('keeps activity fields absent for an older daemon', async () => {
    const client = await clientFor({ ...node, network });
    const description = await client.vms.attach('demo', 'demo-1').describe();
    expect(description).not.toHaveProperty('lastAgentCall');
    expect(description).not.toHaveProperty('openAgentConnections');
    expect(description).not.toHaveProperty('bgExecs');
  });

  it('preserves zero connections with an unknown background registry', async () => {
    const client = await clientFor({ ...node, network, open_agent_connections: 0 });
    const description = await client.vms.attach('demo', 'demo-1').describe();
    expect(description.openAgentConnections).toBe(0);
    expect(description).not.toHaveProperty('bgExecs');
  });

  it('distinguishes a queried empty registry from an unknown registry', async () => {
    const client = await clientFor({ ...node, network, open_agent_connections: 0, bg_execs: [] });
    const description = await client.vms.attach('demo', 'demo-1').describe();
    expect(description.openAgentConnections).toBe(0);
    expect(description.bgExecs).toEqual([]);
  });

  it('maps running and exited jobs, including a successful zero exit code', async () => {
    const client = await clientFor({
      ...node,
      network,
      last_agent_call: marker,
      open_agent_connections: 2,
      bg_execs: [
        { exec_id: 'ex_running', command: 'sleep', pid: 123, state: 'running', started_at: marker },
        { exec_id: 'ex_done', state: 'exited', exit_code: 0 },
      ],
    });
    const description = await client.vms.attach('demo', 'demo-1').describe();
    const jobs: BgExecSummary[] = [
      { execId: 'ex_running', command: 'sleep', pid: 123, state: 'running', startedAt: marker },
      { execId: 'ex_done', state: 'exited', exitCode: 0 },
    ];
    expect(description.lastAgentCall).toBe(marker);
    expect(description.openAgentConnections).toBe(2);
    expect(description.bgExecs).toEqual(jobs);
  });
});
