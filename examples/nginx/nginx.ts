/**
 * nginx port-forward example for @slicervm/sdk.
 *
 * Flow:
 *   1. Create a VM with userdata that apt-installs nginx and starts it.
 *      Block server-side via `wait: 'userdata'` so the daemon's long-poll
 *      hands back a ready-to-serve VM.
 *   2. Open a host-side port-forward: `127.0.0.1:8080` → VM `127.0.0.1:80`.
 *   3. Fetch the welcome page from the host through the forward and assert
 *      the bytes look right.
 *   4. Tear down the forward and delete the VM.
 *
 * Usage:
 *   SLICER_URL=~/slicer-mac/slicer.sock npx tsx nginx.ts
 *   SLICER_URL=https://slicer.example.com SLICER_TOKEN=... npx tsx nginx.ts
 */

import { SlicerClient, GiB } from '@slicervm/sdk';

const HOST_GROUP = process.env.SLICER_HOST_GROUP ?? 'sbox';

const USERDATA = `#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qy
apt-get install -qy nginx
# nginx's deb already starts the unit; this is a belt-and-braces no-op when ok.
systemctl enable --now nginx
`;

async function main() {
  const totalStart = Date.now();
  const client = SlicerClient.fromEnv();

  console.log(`→ creating VM in "${HOST_GROUP}" with nginx userdata (blocking on wait=userdata)…`);
  const vm = await client.vms.create(
    HOST_GROUP,
    { cpus: 1, ramBytes: GiB(1), userdata: USERDATA, tags: ['nginx-example'] },
    { wait: 'userdata', waitTimeoutSec: 300 },
  );
  console.log(`  VM ${vm.hostname} (${vm.ip}) ready in ${ms(Date.now() - totalStart)}`);

  try {
    console.log('→ opening forward 127.0.0.1:8080 → VM:80…');
    const fwd = await vm.forward('127.0.0.1:8080:127.0.0.1:80');
    const local = fwd.listeners[0]!;
    console.log(`  ${local.local} → ${local.remote}`);

    console.log('→ GET http://127.0.0.1:8080/');
    const res = await fetch('http://127.0.0.1:8080/');
    const body = await res.text();
    console.log(`  status=${res.status} bytes=${body.length}`);

    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    if (!body.includes('Welcome to nginx')) {
      throw new Error('response body did not contain "Welcome to nginx"');
    }
    console.log('  ✓ welcome page served end-to-end via port-forward');

    await fwd.close();
  } finally {
    console.log(`→ deleting VM ${vm.hostname}…`);
    await vm.delete().catch((e) => console.error('  delete failed:', e));
  }

  console.log(`done in ${ms(Date.now() - totalStart)}`);
}

function ms(n: number): string {
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

main().catch((err) => {
  console.error('error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
