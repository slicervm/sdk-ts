import { describe, expect, it } from 'vitest';
import { VMsAPI } from '../src/namespaces.js';
import type { TransportClient } from '../src/transport.js';
import type { WireHostGroup } from '../src/wire.js';

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function makeApi(
  respond: (method: string, path: string) => unknown,
): { api: VMsAPI; calls: Call[] } {
  const calls: Call[] = [];
  const transport = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return respond(method, path);
    },
  } as unknown as TransportClient;
  return { api: new VMsAPI(transport), calls };
}

const created = { hostname: 'vm-1', ip: '10.0.0.2', created_at: 't' };
const group = (name: string): WireHostGroup => ({ name });

describe('VMsAPI default hostgroup resolution', () => {
  it('uses the explicit host group when given', async () => {
    const { api, calls } = makeApi(() => created);
    await api.createRaw('sbox', {});
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/hostgroup/sbox/nodes');
  });

  it('resolves a single configured host group when empty', async () => {
    const { api, calls } = makeApi((m, p) =>
      p === '/hostgroup' ? [group('sbox')] : created,
    );
    const res = await api.createRaw('', {});
    expect(res.hostname).toBe('vm-1');
    expect(calls[0]!.path).toBe('/hostgroup');
    expect(calls[1]!.path).toBe('/hostgroup/sbox/nodes');
  });

  it('throws when no host groups are configured', async () => {
    const { api } = makeApi((m, p) => (p === '/hostgroup' ? [] : created));
    await expect(api.createRaw('', {})).rejects.toThrow('no host groups configured');
  });

  it('throws when more than one host group is configured', async () => {
    const { api } = makeApi((m, p) =>
      p === '/hostgroup' ? [group('a'), group('b')] : created,
    );
    await expect(api.createRaw('', {})).rejects.toThrow(
      'host group is required when more than one is configured',
    );
  });
});
