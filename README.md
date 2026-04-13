# @slicervm/sdk

TypeScript SDK for the [Slicer](https://slicervm.com) VM control-plane API.

Mirrors the [Go SDK](https://github.com/slicervm/sdk) semantically. The top-level `SlicerClient` exposes `hostGroups`, `vms`, and `secrets` namespaces for control-plane operations; per-VM operations live on a `VM` handle returned from `client.vms.create()` / `client.vms.attach()`.

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

await vm.delete();
```

## Status

Pre-release. See `ts-plan.md`.
