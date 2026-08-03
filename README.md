# @slicervm/sdk

TypeScript SDK for the [Slicer](https://slicervm.com) VM control-plane API.

Mirrors the [Go SDK](https://github.com/slicervm/sdk) semantically. The top-level `SlicerClient` exposes `hostGroups`, `vms`, `commits`, and `secrets` namespaces for control-plane operations; per-VM operations live on a `VM` handle returned from `client.vms.create()` / `client.vms.attach()`.

Supports Unix socket and HTTP(S) transports.

```ts
import { SlicerClient, GiB } from '@slicervm/sdk';

const client = new SlicerClient({ baseURL: '/Users/me/slicer-mac/slicer.sock' });

const vm = await client.vms.create(
  'sbox',
  { cpus: 1, ramBytes: GiB(1) },
  { wait: 'agent', waitTimeoutSec: 60 },
);

const result = await vm.execBuffered({ command: 'uname', args: ['-a'] });
console.log(result.stdout);

await vm.fs.writeFile('/tmp/hello.txt', 'hi');
console.log((await vm.fs.readFile('/tmp/hello.txt')).toString());

// Background exec — detached, survives disconnect, logs into an agent-side
// ring buffer. Manage via vm.bg.list/info/logs/kill/wait/remove.
const bg = await vm.bg.exec({ command: 'npm', args: ['run', 'dev'], cwd: '/app' });
for await (const f of vm.bg.logs(bg.execId, { follow: true })) {
  if (f.stdoutBytes) process.stdout.write(f.stdoutBytes);
}

await vm.delete();
```

## Cold forks

A stopped persistent VM can be committed as an immutable disk parent, then
forked into cold-booted children. Fork calls always wait until the child agent
has finalised its guest identity.

```ts
await vm.shutdown();
const parent = await vm.commit({
  tags: ['node-build'],
  cacheKey: 'node-build-v1',
});

const child = await parent.fork(undefined, {
  waitTimeoutSec: 120,
  network: { allow: [], drop: ['0.0.0.0/0'] },
});

const description = await child.describe();
console.log(description.parentCommitId, description.network.effective);

const cached = await client.commits.list({ cacheKey: 'node-build-v1' });
await child.delete();
await vm.delete();
await client.commits.delete(parent.commitId);
```

## Status

Pre-release. See `ts-plan.md`.
