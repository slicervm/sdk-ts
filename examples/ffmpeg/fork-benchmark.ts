/**
 * Prepare one persistent VM with ffmpeg + an input video, stop it, commit its
 * disk as an immutable parent, then fork N children and transcode in parallel.
 *
 * Usage:
 *   SLICER_URL=./slicer.sock SLICER_HOST_GROUP=ffx npx tsx fork-benchmark.ts input.mkv out
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  GiB,
  SlicerAPIError,
  SlicerClient,
  type CommittedVM,
  type VM,
} from '@slicervm/sdk';

const execFileAsync = promisify(execFile);

const HOST_GROUP = process.env.SLICER_HOST_GROUP ?? 'sbox';
const JOBS = Number.parseInt(process.env.SLICER_FFMPEG_JOBS ?? '10', 10);
const RUN_TAG = 'ffmpeg-fork-benchmark';
const GUEST_INPUT = '/opt/slicer-input.mkv';

async function main() {
  const [inputPath, outputDir = 'out'] = process.argv.slice(2);
  if (!inputPath) {
    console.error('usage: fork-benchmark.ts <input.mkv> [output-dir]');
    process.exit(2);
  }

  const inputBytes = await fs.readFile(inputPath);
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const client = SlicerClient.fromEnv();
  await cleanupTaggedVMs(client);

  const started = Date.now();
  const parent = await timed('launch parent', () =>
    client.vms.create(
      HOST_GROUP,
      {
        cpus: 2,
        ramBytes: GiB(2),
        persistent: true,
        tags: [RUN_TAG, 'role=parent'],
      },
      { wait: 'agent', waitTimeoutSec: 180 },
    ),
  );

  let committed: CommittedVM | undefined;
  try {
    await timed('install ffmpeg', async () => {
      const res = await parent.execBuffered({
        command: '/bin/sh',
        args: [
          '-c',
          'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg',
        ],
        uid: 0,
        gid: 0,
      });
      if (res.exitCode !== 0) throw new Error(res.stderr.toString());
    });

    await timed('upload input', () =>
      parent.fs.writeFile(GUEST_INPUT, inputBytes, { uid: 0, gid: 0, permissions: '0644' }),
    );
    await assertGuestInput(parent);
    await timed('sync guest disk', async () => {
      const res = await parent.execBuffered({ command: 'sync', uid: 0, gid: 0 });
      if (res.exitCode !== 0) throw new Error(res.stderr.toString());
    });
    await timed('stop parent', () => parent.shutdown());
    committed = await timed('commit parent disk', () =>
      parent.commit({ tags: [RUN_TAG], cacheKey: RUN_TAG }),
    );
    console.log(`commit_id=${committed.commitId} mode=${committed.mode}`);

    const forked = await Promise.all(
      Array.from({ length: JOBS }, async (_, i) => {
        const child = await timed(`fork ${i + 1}`, () =>
          committed!.fork(`${HOST_GROUP}-${i + 2}`, { waitTimeoutSec: 180 }),
        );
        return child;
      }),
    );

    const results = await Promise.all(
      forked.map((vm, i) => convertOne(vm, i + 1, outputDir).finally(() => vm.delete().catch(() => {}))),
    );

    const totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);
    const totalMs = Date.now() - started;
    console.log(
      `done jobs=${results.length} total=${(totalMs / 1000).toFixed(1)}s bytes=${totalBytes}`,
    );
  } finally {
    await cleanupTaggedVMs(client);
    if (committed) {
      await client.commits.delete(committed.commitId).catch((err) => {
        if (err instanceof SlicerAPIError && err.status === 404) return;
        throw err;
      });
    }
  }
}

async function cleanupTaggedVMs(client: SlicerClient): Promise<void> {
  const vms = await client.vms.list({ tag: RUN_TAG });
  if (vms.length === 0) return;
  console.log(`cleanup tagged VMs: ${vms.map((v) => v.hostname).join(', ')}`);
  await Promise.all(
    vms.map(async (info) => {
      if (!info.hostGroup) return;
      await client.vms.attach(info.hostGroup, info.hostname).delete().catch((err) => {
        if (err instanceof SlicerAPIError && err.status === 404) return;
        throw err;
      });
    }),
  );
}

async function assertGuestInput(vm: VM): Promise<void> {
  const res = await vm.execBuffered({
    command: 'ffprobe',
    args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', GUEST_INPUT],
  });
  if (res.exitCode !== 0) throw new Error(`ffprobe input failed: ${res.stderr}`);
  console.log(`input_duration=${res.stdout.trim()}s`);
}

async function convertOne(vm: VM, job: number, outputDir: string): Promise<{ bytes: number }> {
  const outputPath = path.join(outputDir, `output-${String(job).padStart(2, '0')}.mp4`);
  const t0 = Date.now();
  const res = await vm.execBuffered({
    command: 'ffmpeg',
    args: [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      GUEST_INPUT,
      '-vf',
      'scale=-2:720',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-movflags',
      '+frag_keyframe+empty_moov',
      '-f',
      'mp4',
      'pipe:1',
    ],
    stdio: 'base64',
  });
  if (res.exitCode !== 0) throw new Error(`${vm.hostname}: ffmpeg failed: ${res.stderr}`);
  await fs.writeFile(outputPath, res.stdout);
  await verifyMP4(outputPath, res.stdout);
  const elapsed = Date.now() - t0;
  console.log(`${vm.hostname} job=${job} bytes=${res.stdout.length} elapsed=${elapsed}ms`);
  return { bytes: res.stdout.length };
}

async function verifyMP4(file: string, data: Buffer): Promise<void> {
  if (data.length < 12 || data.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw new Error(`${file}: invalid MP4 header`);
  }
  try {
    await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  } catch {
    // Host ffprobe is optional; the header check above catches the common
    // broken-output case and guest ffprobe already validated the input.
  }
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    console.log(`${label}: ${Date.now() - t0}ms`);
  }
}

main().catch((err) => {
  console.error('error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
