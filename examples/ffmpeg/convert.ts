/**
 * ffmpeg e2e example for @slicervm/sdk.
 *
 * Flow:
 *   1. Create a VM in the `sbox` host group (ephemeral).
 *   2. Install ffmpeg via apt (runs as root with uid=0).
 *   3. Upload the input file into the VM with `vm.fs.writeFile`.
 *   4. Transcode to MP4 (H.264/AAC, 720p cap).
 *   5. Stream the binary result straight back through `execBuffered({ stdio: 'base64' })`
 *      — no intermediate file on the VM's disk. The SDK auto-decodes into a Buffer.
 *   6. Write to local disk. Clean up the VM.
 *
 * Usage:
 *   SLICER_URL=~/slicer-mac/slicer.sock \
 *   npx tsx convert.ts <input.mkv> <output.mp4>
 *
 * If you don't have a test file, generate one first:
 *   ffmpeg -f lavfi -i testsrc=duration=3:size=640x480:rate=24 -c:v libx264 input.mkv
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { SlicerClient, GiB, type VM } from '@slicervm/sdk';

const HOST_GROUP = process.env.SLICER_HOST_GROUP ?? 'sbox';

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    console.error('usage: convert.ts <input> <output>');
    process.exit(2);
  }

  const inputBytes = await fs.readFile(inputPath);
  console.log(`→ input ${path.basename(inputPath)} (${inputBytes.length} bytes)`);

  const client = SlicerClient.fromEnv();

  console.log(`→ creating VM in host group "${HOST_GROUP}" (2 vCPU, 2 GiB)…`);
  const vm: VM = await client.vms.create(
    HOST_GROUP,
    { cpus: 2, ramBytes: GiB(2), tags: ['ffmpeg-example'] },
    { wait: 'agent', waitTimeoutSec: 120 },
  );
  console.log(`  hostname=${vm.hostname} ip=${vm.ip}`);

  try {
    console.log('→ installing ffmpeg…');
    const install = await vm.execBuffered({
      command: '/bin/sh',
      args: [
        '-c',
        'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg',
      ],
      uid: 0,
      gid: 0,
    });
    if (install.exitCode !== 0) {
      throw new Error(`apt install failed (exit ${install.exitCode}): ${install.stderr}`);
    }

    console.log('→ uploading source file…');
    await vm.fs.writeFile('/tmp/input', inputBytes);

    console.log('→ transcoding (H.264/AAC, 720p cap)…');
    const t0 = Date.now();
    const result = await vm.execBuffered({
      command: 'ffmpeg',
      args: [
        '-hide_banner', '-loglevel', 'error',
        '-i', '/tmp/input',
        '-vf', 'scale=-2:720',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
        '-c:a', 'aac',
        '-movflags', '+frag_keyframe+empty_moov',
        '-f', 'mp4', 'pipe:1',
      ],
      stdio: 'base64',
    });
    const elapsedMs = Date.now() - t0;

    if (result.exitCode !== 0) {
      throw new Error(
        `ffmpeg failed (exit ${result.exitCode}): ${result.stderr.toString('utf8')}`,
      );
    }

    console.log(
      `  → ${result.stdout.length} bytes produced in ${(elapsedMs / 1000).toFixed(1)}s`,
    );

    await fs.writeFile(outputPath, result.stdout);
    console.log(`→ wrote ${outputPath} (${result.stdout.length} bytes)`);
  } finally {
    console.log(`→ deleting VM ${vm.hostname}…`);
    await vm.delete().catch((e) => console.error('  delete failed:', e));
  }
}

main().catch((err) => {
  console.error('error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
