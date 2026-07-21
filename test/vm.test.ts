import { describe, expect, it, vi } from 'vitest';
import type { TransportClient } from '../src/transport.js';
import { VM } from '../src/vm.js';

function vmWithHealth(health: object): VM {
  const transport = {
    request: vi.fn().mockResolvedValue(health),
  } as unknown as TransportClient;

  return new VM(transport, { hostname: 'test-1', hostGroup: 'test' });
}

describe('VM.waitForUserdata', () => {
  it('returns a legacy successful result without an exit code', async () => {
    const vm = vmWithHealth({ userdata_ran: true });

    await expect(vm.waitForUserdata({ timeoutMs: 100, intervalMs: 1 })).resolves.toEqual({
      userdataRan: true,
    });
  });

  it('fails immediately for an unsuccessful result', async () => {
    const vm = vmWithHealth({ userdata_ran: true, userdata_exit_code: 17 });

    await expect(vm.waitForUserdata({ timeoutMs: 100, intervalMs: 1 })).rejects.toThrow(
      'userdata failed with exit code 17',
    );
  });
});
