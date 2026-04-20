/**
 * E2E tests for the `vm.bg.*` namespace (background exec). Mirrors the Go
 * SDK's exec_bg coverage. Requires a reachable Slicer daemon — set
 * `SLICER_URL` (and `SLICER_TOKEN` for non-socket transports). Defaults to
 * the same socket path as `vm.e2e.test.ts`.
 *
 * Each `it()` creates a fresh VM with `wait=agent`, exercises one or more
 * bg-exec flows, and is responsible for its own cleanup via the `track()`
 * helper. The VM size is pinned to 1 vCPU / 1 GiB.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SlicerClient, GiB, type VM } from '../src/index.js';

const baseURL =
  process.env.SLICER_URL ?? path.join(os.homedir(), 'slicer-mac', 'slicer.sock');
const token = process.env.SLICER_TOKEN;

function reachable(): boolean {
  if (baseURL.startsWith('http')) return true;
  try {
    return fs.statSync(baseURL).isSocket();
  } catch {
    return false;
  }
}

const HOST_GROUP = process.env.SLICER_HOST_GROUP ?? 'sbox';
const VM_CPUS = 1;
const VM_RAM = GiB(1);

const leaked: VM[] = [];

function track(vm: VM): VM {
  leaked.push(vm);
  return vm;
}

describe.skipIf(!reachable())('vm.bg.* e2e', () => {
  const client = new SlicerClient({ baseURL, ...(token && { token }) });

  afterAll(async () => {
    for (const vm of leaked) {
      try {
        await vm.delete();
      } catch {
        /* best effort */
      }
    }
  });

  async function freshVM(tag: string): Promise<VM> {
    return track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, tags: [tag] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
  }

  it('exec(sleep) → list → info → kill → list shows exited', async () => {
    const vm = await freshVM('sdk-ts-bg-explicit');
    const launched = await vm.bg.exec({ command: 'sleep', args: ['600'] });
    expect(launched.execId).toMatch(/^ex_/);
    expect(launched.pid).toBeGreaterThan(0);
    expect(launched.startedAt).toBeTruthy();
    expect(launched.ringBytes).toBeGreaterThan(0);

    const list = await vm.bg.list();
    const found = list.find((e) => e.execId === launched.execId);
    expect(found).toBeDefined();
    expect(found?.running).toBe(true);
    expect(found?.command).toBe('sleep');

    const info = await vm.bg.info(launched.execId);
    expect(info.execId).toBe(launched.execId);
    expect(info.running).toBe(true);
    expect(info.command).toBe('sleep');
    expect(info.args).toEqual(['600']);

    const kill = await vm.bg.kill(launched.execId);
    expect(kill.signalSent.toUpperCase()).toContain('TERM');

    // Server may report running=true momentarily before SIGTERM lands; wait.
    const exited = await vm.bg.wait(launched.execId, 10);
    expect(exited.running).toBe(false);
    expect(exited.timedOut).toBe(false);

    const after = await vm.bg.info(launched.execId);
    expect(after.running).toBe(false);
  });

  it('exec(shell) — shell form runs $VAR-expanding script', async () => {
    const vm = await freshVM('sdk-ts-bg-shell');
    // env FOO=42, sleep $FOO seconds. If expansion failed, sleep would error
    // immediately and we'd see exit_code != 0 in the wait response.
    const launched = await vm.bg.exec({
      command: 'sleep $FOO',
      shell: '/bin/bash',
      env: ['FOO=2'],
    });
    expect(launched.execId).toMatch(/^ex_/);

    const exited = await vm.bg.wait(launched.execId, 8);
    expect(exited.running).toBe(false);
    expect(exited.exitCode).toBe(0);
  });

  it('logs(follow=false) replays staged build output and ends', async () => {
    const vm = await freshVM('sdk-ts-bg-logs');
    const launched = await vm.bg.exec({
      command: 'for i in $(seq 1 3); do echo "stage $i"; sleep 1; done; echo DONE',
      shell: '/bin/bash',
    });

    // Wait until child exits so the ring is fully populated, then replay.
    const exit = await vm.bg.wait(launched.execId, 10);
    expect(exit.exitCode).toBe(0);

    const lines: string[] = [];
    for await (const f of vm.bg.logs(launched.execId, { follow: false })) {
      const text =
        f.stdoutBytes?.toString('utf8') ??
        f.dataBytes?.toString('utf8') ??
        f.stdout ??
        f.data ??
        '';
      if (text) lines.push(text.trim());
    }
    const joined = lines.join('|');
    expect(joined).toContain('stage 1');
    expect(joined).toContain('stage 2');
    expect(joined).toContain('stage 3');
    expect(joined).toContain('DONE');
  });

  it('remove() reaps the ring; subsequent info returns 410', async () => {
    const vm = await freshVM('sdk-ts-bg-remove');
    const launched = await vm.bg.exec({ command: 'echo', args: ['hello'] });
    await vm.bg.wait(launched.execId, 5);

    const reaped = await vm.bg.remove(launched.execId);
    expect(reaped.execId).toBe(launched.execId);
    expect(reaped.reaped).toBe(true);

    await expect(vm.bg.info(launched.execId)).rejects.toThrow();
  });

  it('exec without command rejects client-side', async () => {
    const vm = await freshVM('sdk-ts-bg-noargs');
    // @ts-expect-error — intentional missing required field
    await expect(vm.bg.exec({})).rejects.toThrow(/command is required/);
  });
});
