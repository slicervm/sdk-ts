/**
 * Opt-in restore regression on a Linux Firecracker hostgroup supporting snapshots:
 * SLICER_RESTORE_E2E=1 SLICER_HOST_GROUP=mbox npx vitest run test/restore.e2e.test.ts
 * Uses SLICER_URL / SLICER_TOKEN and creates/deletes only a uniquely tagged test VM.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GiB, SlicerClient, type RestoreOptions, type VM } from '../src/index.js';

describe.skipIf(process.env.SLICER_RESTORE_E2E !== '1')('Linux restore readiness e2e', () => {
  const tag = `workflow=sdk-ts-restore-${randomUUID()}`;
  const marker = '/dev/shm/sdk-ts-restore-marker';
  let client: SlicerClient | undefined;
  let vm: VM;
  let group: string;

  beforeAll(async () => {
    group = process.env.SLICER_HOST_GROUP ?? '';
    if (!group) throw new Error('Set SLICER_HOST_GROUP to a snapshot-capable Linux Firecracker hostgroup');
    client = SlicerClient.fromEnv();
    const info = await client.getInfo();
    expect(info.platform).toBe('linux');
    console.info(JSON.stringify({ event: 'restore_e2e_context', info, group, tag }));
    // Capture the hostname before waiting so cleanup can find the VM if readiness fails.
    const created = await client.vms.createRaw(group, {
      cpus: 1, ramBytes: GiB(1), persistent: true, tags: [tag],
    });
    vm = client.vms.attach(group, created.hostname);
    console.info(JSON.stringify({ event: 'restore_e2e_allocated', hostname: vm.hostname }));
    await vm.waitForAgent({ timeoutMs: 60000, intervalMs: 100 });
    const result = await vm.execBuffered({
      command: '/bin/sh', args: ['-c', `printf '%s' '${tag}' > ${marker}`], uid: 0,
    });
    expect(result.exitCode).toBe(0);
  }, 90000);

  afterAll(async () => {
    if (!client) return;
    // Tag lookup also recovers an allocation whose create response was lost.
    const owned = await client.hostGroups.listVMs(group, { tag });
    const names = new Set(owned.map(node => node.hostname));
    if (vm) names.add(vm.hostname);
    for (const hostname of names) await client.vms.attach(group, hostname).delete();
    expect(await client.hostGroups.listVMs(group, { tag })).toHaveLength(0);
    console.info(JSON.stringify({ event: 'restore_e2e_cleanup', deleted: [...names], remaining: 0 }));
  });

  it.each<[string, RestoreOptions]>([
    ['zero timeout', { wait: 'agent', timeoutSec: 0 }],
    ['omitted timeout', { wait: 'agent' }],
    ['positive timeout', { wait: 'agent', timeoutSec: 60 }],
    ['negative timeout', { wait: 'agent', timeoutSec: -1 }],
  ])('%s returns an immediately ready VM with memory preserved', async (label, opts) => {
    await vm.suspend();
    const start = performance.now();
    await vm.restore(opts);
    const restoreMs = Math.round(performance.now() - start);
    // No polling here: the restore response itself must guarantee readiness.
    expect((await vm.health()).hostname).toBe(vm.hostname);
    const result = await vm.execBuffered({ command: '/bin/cat', args: [marker], uid: 0 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(tag);
    console.info(JSON.stringify({ event: 'restore_e2e_pass', case: label, restoreMs, immediateHealth: true }));
  }, 90000);
});
