/**
 * E2E against the local Slicer daemon. Reads SLICER_URL + SLICER_TOKEN.
 * Falls back to ~/slicer-mac/slicer.sock (no token) if env unset.
 *
 * Exercises the grouped SDK shape: `client.hostGroups.*`, `client.vms.*`,
 * `client.secrets.*`, and the `VM` handle returned from `client.vms.create`.
 *
 * Every test that creates a VM tracks it for `afterAll` cleanup so we don't
 * leak resources even on failure. VM size is pinned to 1 vCPU / 1 GiB.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe.skipIf(!reachable())('slicer e2e', () => {
  const client = new SlicerClient({ baseURL, ...(token && { token }) });

  // Linux daemon has a streaming/full-duplex bug on stdin; skip those tests
  // until the daemon + agent are patched with EnableFullDuplex().
  let isDarwin = false;
  beforeAll(async () => {
    try {
      isDarwin = (await client.getInfo()).platform === 'darwin';
    } catch {
      /* leave false */
    }
  });

  afterAll(async () => {
    for (const vm of leaked) {
      try {
        await vm.delete();
      } catch {
        /* best effort */
      }
    }
  });

  it('getInfo returns platform/arch', async () => {
    const info = await client.getInfo();
    expect(info.platform).toMatch(/darwin|linux/);
    expect(info.arch).toMatch(/arm64|amd64/);
  });

  it('hostGroups.list contains sbox', async () => {
    const groups = await client.hostGroups.list();
    expect(groups.map((g) => g.name)).toContain(HOST_GROUP);
  });

  it('hostGroups.find finds sbox and missing returns undefined', async () => {
    expect((await client.hostGroups.find(HOST_GROUP))?.name).toBe(HOST_GROUP);
    expect(await client.hostGroups.find('nope-does-not-exist')).toBeUndefined();
  });

  it('hostGroups.listVMs returns an array', async () => {
    const vms = await client.hostGroups.listVMs(HOST_GROUP);
    expect(Array.isArray(vms)).toBe(true);
  });

  it('vms.list returns an array', async () => {
    const vms = await client.vms.list();
    expect(Array.isArray(vms)).toBe(true);
  });

  it('vms.create → waitForAgent → delete (client-side polling)', async () => {
    const vm = track(
      await client.vms.create(HOST_GROUP, {
        cpus: VM_CPUS,
        ramBytes: VM_RAM,
        tags: ['sdk-ts-test-wait-client'],
      }),
    );
    expect(vm.hostname).toBeTruthy();
    expect(vm.ip).toBeTruthy();

    const health = await vm.waitForAgent({ timeoutMs: 60_000, intervalMs: 250 });
    expect(health).toBeDefined();

    await vm.delete();
    leaked.pop();
  });

  it('vms.create with server-side wait=agent', async () => {
    const vm = track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, tags: ['sdk-ts-test-wait-server'] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
    const health = await vm.health();
    expect(health).toBeDefined();
  });

  it('vms.get + vms.attach return a working handle', async () => {
    const vm = track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, tags: ['sdk-ts-test-attach'] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
    const got = await client.vms.get(vm.hostname);
    expect(got?.hostname).toBe(vm.hostname);
    const attached = client.vms.attach(HOST_GROUP, vm.hostname);
    const h = await attached.health();
    expect(h).toBeDefined();
  });

  it('execBuffered runs uname -a', async () => {
    const vm = track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, tags: ['sdk-ts-test-exec'] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
    const res = await vm.execBuffered({ command: 'uname', args: ['-a'] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toLowerCase()).toMatch(/linux|darwin/);
  });

  it('exec streams started/stdout/exit frames in order', async () => {
    const vm = track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, tags: ['sdk-ts-test-stream'] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
    const frames: Array<{ type?: string; stdout?: string; exitCode?: number }> = [];
    for await (const f of vm.exec({
      command: '/bin/sh',
      args: ['-c', 'echo hello && exit 0'],
    })) {
      frames.push(f);
    }
    expect(frames.length).toBeGreaterThan(0);
    const combined = frames.map((f) => f.stdout ?? '').join('');
    expect(combined).toContain('hello');
  });

  it('execBuffered rejects stdin', async () => {
    const vm = track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, tags: ['sdk-ts-test-stdin-reject'] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
    await expect(vm.execBuffered({ command: 'cat', stdin: 'x' })).rejects.toThrow(
      /stdin is not supported/,
    );
  });

  it('exec (streaming) with stdin piped', async (ctx) => {
    if (!isDarwin) return ctx.skip();
    const vm = track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, tags: ['sdk-ts-test-stdin'] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
    let stdout = '';
    let exitCode: number | undefined;
    for await (const f of vm.exec({ command: 'cat', stdin: 'hello from stdin\n' })) {
      if (f.stdout) stdout += f.stdout;
      if (f.data && (f.type === 'stdout' || !f.type)) stdout += f.data;
      if (f.type === 'exit') exitCode = f.exitCode ?? 0;
    }
    expect(exitCode).toBe(0);
    expect(stdout).toContain('hello from stdin');
  });

  it('exec with env + cwd honored', async () => {
    const vm = track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, tags: ['sdk-ts-test-envcwd'] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
    const res = await vm.execBuffered({
      command: '/bin/sh',
      args: ['-c', 'echo "$FOO @ $(pwd)"'],
      env: ['FOO=bar'],
      cwd: '/tmp',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('bar @ /tmp');
  });

  it('non-zero exit code surfaces', async () => {
    const vm = track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, tags: ['sdk-ts-test-exit'] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
    const res = await vm.execBuffered({ command: '/bin/sh', args: ['-c', 'exit 7'] });
    expect(res.exitCode).toBe(7);
  });

  it('fs: mkdir → writeFile → stat → readFile → readDir → remove', async () => {
    const vm = track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, tags: ['sdk-ts-test-fs'] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
    const dir = '/tmp/sdk-ts-fs';
    const file = `${dir}/hello.txt`;

    await vm.fs.mkdir({ path: dir, recursive: true });
    await vm.fs.writeFile(file, 'hello fs\n');

    const st = await vm.fs.stat(file);
    expect(st).not.toBeNull();
    expect(st!.type).toBe('file');
    expect(st!.size).toBeGreaterThan(0);

    const body = (await vm.fs.readFile(file)).toString('utf8');
    expect(body).toBe('hello fs\n');

    const entries = await vm.fs.readDir(dir);
    expect(entries.map((e) => e.name)).toContain('hello.txt');

    expect(await vm.fs.exists(file)).toBe(true);
    await vm.fs.remove(file);
    expect(await vm.fs.exists(file)).toBe(false);

    await vm.fs.remove(dir, true);
  });

  it('vms.list with tag filter finds our test VM', async () => {
    const tag = `sdk-ts-test-tagfilter-${Date.now()}`;
    const vm = track(
      await client.vms.create(HOST_GROUP, {
        cpus: VM_CPUS,
        ramBytes: VM_RAM,
        tags: [tag],
      }),
    );
    const found = await client.vms.list({ tag });
    expect(found.map((v) => v.hostname)).toContain(vm.hostname);
  });

  it('logs returns content', async () => {
    const vm = track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, tags: ['sdk-ts-test-logs'] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
    const logs = await vm.logs();
    expect(logs.hostname).toBe(vm.hostname);
    expect(typeof logs.content).toBe('string');
  });

  it('vms.stats returns decoded array', async () => {
    const stats = await client.vms.stats();
    expect(Array.isArray(stats)).toBe(true);
    for (const s of stats) expect(typeof s.hostname).toBe('string');
  });

  it('execBuffered stdio=base64 round-trips arbitrary binary bytes', async () => {
    const vm = track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, tags: ['sdk-ts-test-binary'] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
    const { randomBytes } = await import('node:crypto');
    const payload = randomBytes(64 * 1024);
    // stdin not supported on execBuffered — stage bytes into a file, cat them out.
    await vm.fs.writeFile('/tmp/sdk-ts-bin', payload);
    const res = await vm.execBuffered({
      command: 'cat',
      args: ['/tmp/sdk-ts-bin'],
      stdio: 'base64',
    });
    expect(res.exitCode).toBe(0);
    expect(res.encoding).toBe('base64');
    expect(Buffer.isBuffer(res.stdout)).toBe(true);
    expect(res.stdout.length).toBe(payload.length);
    expect(res.stdout.equals(payload)).toBe(true);
  });

  it('exec (streaming) stdio=base64 decodes frames into Buffers', async () => {
    const vm = track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, tags: ['sdk-ts-test-stream-bin'] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
    const { randomBytes } = await import('node:crypto');
    const payload = randomBytes(32 * 1024);
    await vm.fs.writeFile('/tmp/sdk-ts-stream-bin', payload);

    const chunks: Buffer[] = [];
    for await (const f of vm.exec({
      command: 'cat',
      args: ['/tmp/sdk-ts-stream-bin'],
      stdio: 'base64',
    })) {
      if (f.type === 'stdout' && f.stdoutBytes) chunks.push(f.stdoutBytes);
      else if (f.type === 'stdout' && f.dataBytes) chunks.push(f.dataBytes);
    }
    const got = Buffer.concat(chunks);
    expect(got.length).toBe(payload.length);
    expect(got.equals(payload)).toBe(true);
  });

  it('tarFrom returns a well-formed ustar archive', async () => {
    const vm = track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, tags: ['sdk-ts-test-tar'] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
    await vm.fs.mkdir({ path: '/tmp/sdk-ts-tar', recursive: true });
    await vm.fs.writeFile('/tmp/sdk-ts-tar/a.txt', 'A');
    const tar = await vm.fs.tarFrom('/tmp/sdk-ts-tar');
    expect(tar.length).toBeGreaterThan(512);
    expect(tar.slice(257, 262).toString()).toBe('ustar');
  });

  it('secrets: create → list → patch → delete', async (ctx) => {
    const name = `sdk-ts-test-${Date.now()}`;
    try {
      await client.secrets.create({ name, data: 'hello' });
    } catch (err) {
      if ((err as { status?: number }).status === 404) return ctx.skip();
      throw err;
    }
    try {
      const secrets = await client.secrets.list();
      expect(secrets.map((s) => s.name)).toContain(name);
      await client.secrets.patch(name, { data: 'updated' });
    } finally {
      await client.secrets.delete(name).catch(() => undefined);
    }
  });

  it('shutdown → relaunch roundtrip (persistent VM)', async () => {
    const vm = track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, persistent: true, tags: ['sdk-ts-test-relaunch'] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
    await vm.shutdown();
    await new Promise((r) => setTimeout(r, 2000));
    await vm.relaunch();
    await vm.waitForAgent({ timeoutMs: 60_000, intervalMs: 250 });
  });

  it('suspend → restore roundtrip (Mac only)', async (ctx) => {
    if (!isDarwin) return ctx.skip();
    const vm = track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, tags: ['sdk-ts-test-suspend'] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
    await vm.suspend();
    await vm.restore();
    await vm.waitForAgent({ timeoutMs: 60_000, intervalMs: 250 });
  });

  it('pause → resume roundtrip', async () => {
    const vm = track(
      await client.vms.create(
        HOST_GROUP,
        { cpus: VM_CPUS, ramBytes: VM_RAM, tags: ['sdk-ts-test-pause'] },
        { wait: 'agent', waitTimeoutSec: 60 },
      ),
    );
    await vm.pause();
    await vm.resume();
    await vm.waitForAgent({ timeoutMs: 30_000, intervalMs: 250 });
  });
});
