/**
 * Minimal lifecycle example for @slicervm/sdk:
 *   1. Create a VM in the `sbox` host group.
 *   2. Run `uname -a` inside it.
 *   3. Delete the VM.
 *
 * Usage:
 *   SLICER_URL=~/slicer-mac/slicer.sock npx tsx run-command.ts
 *   # or, against a remote daemon:
 *   SLICER_URL=https://slicer.example.com SLICER_TOKEN=... npx tsx run-command.ts
 */

import { SlicerClient, GiB } from '@slicervm/sdk';

const HOST_GROUP = process.env.SLICER_HOST_GROUP ?? 'sbox';

async function main() {
  const client = SlicerClient.fromEnv();

  // Create the VM and block server-side until the in-guest agent is reachable.
  const vm = await client.vms.create(
    HOST_GROUP,
    { cpus: 1, ramBytes: GiB(1) },
    { wait: 'agent', waitTimeoutSec: 60 },
  );
  console.log(`created ${vm.hostname} (${vm.ip})`);

  try {
    const result = await vm.execBuffered({ command: 'uname', args: ['-a'] });
    console.log(`exit=${result.exitCode}`);
    console.log(result.stdout.trim());
  } finally {
    await vm.delete();
    console.log(`deleted ${vm.hostname}`);
  }
}

main().catch((err) => {
  console.error('error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
