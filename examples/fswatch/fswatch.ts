/**
 * Filesystem-watch example for @slicervm/sdk.
 *
 * Creates a VM, opens an SSE-backed filesystem watch on `/tmp/build-out`,
 * and in a second task runs a fake "build" that emits files. Each event
 * prints to stdout as it lands on disk — the use case agent/sandbox tools
 * care about (e.g. streaming live feedback while an LLM writes code or a
 * compiler lays down binaries).
 *
 * Usage:
 *   SLICER_URL=~/slicer-mac/slicer.sock npx tsx fswatch.ts
 */

import { SlicerClient, GiB } from '@slicervm/sdk';

const HOST_GROUP = process.env.SLICER_HOST_GROUP ?? 'sbox';

const USERDATA = `#!/bin/bash
set -euo pipefail
mkdir -p /tmp/build-out
chown -R ubuntu:ubuntu /tmp/build-out
`;

async function main() {
  const client = SlicerClient.fromEnv();

  console.log('→ creating VM…');
  const vm = await client.vms.create(
    HOST_GROUP,
    { cpus: 1, ramBytes: GiB(1), userdata: USERDATA, tags: ['fswatch-example'] },
    { wait: 'userdata', waitTimeoutSec: 120 },
  );
  console.log(`  ${vm.hostname} ready`);

  try {
    console.log('→ opening fs watch on /tmp/build-out…');

    // Fire the watch in the background. Break after 5 events or 10s.
    const watcher = (async () => {
      const events: string[] = [];
      const timeout = setTimeout(() => {}, 10_000);
      for await (const e of vm.fs.watch({
        paths: ['/tmp/build-out'],
        recursive: true,
        events: ['create'],
      })) {
        const label = `[watch] id=${e.id} ${e.type} ${e.path} (${e.size}B)`;
        console.log(label);
        events.push(label);
        if (events.length >= 5) break;
      }
      clearTimeout(timeout);
      return events;
    })();

    // Give the SSE stream a beat to subscribe before the writes start.
    await new Promise((r) => setTimeout(r, 500));

    console.log('→ running fake build (emits 5 files with 250ms gaps)…');
    const buildCmd = [
      '-c',
      `for i in 1 2 3 4 5; do
         dd if=/dev/urandom of=/tmp/build-out/artifact-$i.bin bs=1024 count=$((i*16)) 2>/dev/null
         sleep 0.25
       done`,
    ];
    const buildResult = await vm.execBuffered({
      command: '/bin/sh',
      args: buildCmd,
      uid: 1000,
      gid: 1000,
    });
    if (buildResult.exitCode !== 0) {
      throw new Error(`build failed: ${buildResult.stderr}`);
    }

    const events = await Promise.race([
      watcher,
      new Promise<string[]>((_, rej) =>
        setTimeout(() => rej(new Error('watch timed out waiting for events')), 8000),
      ),
    ]);

    console.log(`→ captured ${events.length} event(s) live from the guest filesystem.`);
  } finally {
    console.log(`→ deleting ${vm.hostname}…`);
    await vm.delete().catch(() => {});
  }
}

main().catch((err) => {
  console.error('error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
