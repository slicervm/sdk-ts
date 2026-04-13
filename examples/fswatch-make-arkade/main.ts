/**
 * fswatch-make-arkade — TypeScript port of slicervm/sdk's
 * examples/watch-make-arkade-bin. Streams filesystem events from a microVM
 * while `make dist` produces arkade cross-compiled binaries, printing one
 * line per final binary as it lands on disk.
 *
 * Attaches to an existing VM (does not create or delete it). The Go example
 * behaves the same way; pair it with your own orchestration.
 *
 * Expected setup inside the VM:
 *
 *   git clone https://github.com/alexellis/arkade ~/src/arkade
 *   arkade system install go
 *
 * Usage:
 *
 *   SLICER_URL=https://slicer.example.com SLICER_TOKEN=... \
 *     npx tsx main.ts --vm demo-1 --path /home/ubuntu/src/arkade/bin
 *
 * In another terminal (or from your own orchestration) run:
 *
 *   slicer vm exec demo-1 --uid 1000 -- \
 *     "cd ~/src/arkade && PATH=/usr/local/go/bin:$PATH make dist"
 *
 * Each produced binary prints a single line to stdout as it lands on disk.
 */

import path from 'node:path';
import { SlicerClient, type FSWatchEvent } from '@slicervm/sdk';

interface Args {
  url: string;
  token: string;
  vm: string;
  hostGroup: string;
  path: string;
  patterns: string[];
  uid: number;
  verbose: boolean;
  timeoutSec: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (long: string, short?: string): string | undefined => {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === `--${long}` || (short && a === `-${short}`)) return argv[i + 1];
      if (a.startsWith(`--${long}=`)) return a.slice(long.length + 3);
    }
    return undefined;
  };
  const flag = (long: string, short?: string): boolean =>
    argv.includes(`--${long}`) || (short !== undefined && argv.includes(`-${short}`));

  return {
    url: get('url') ?? process.env.SLICER_URL ?? '',
    token: get('token') ?? process.env.SLICER_TOKEN ?? '',
    vm: get('vm') ?? '',
    hostGroup: get('host-group') ?? process.env.SLICER_HOST_GROUP ?? 'sbox',
    path: get('path') ?? '/home/ubuntu/src/arkade/bin',
    patterns: splitCSV(get('pattern') ?? 'arkade*'),
    uid: parseInt(get('uid') ?? '1000', 10),
    verbose: flag('verbose', 'v'),
    timeoutSec: parseInt(get('timeout') ?? '600', 10),
  };
}

function splitCSV(s: string): string[] {
  return s
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function usage(): never {
  console.error(
    `Usage: main.ts --vm <hostname> [--url URL] [--token TOKEN] [--host-group sbox]
                      [--path /home/ubuntu/src/arkade/bin]
                      [--pattern "arkade*"] [--uid 1000]
                      [-v|--verbose] [--timeout 600]

Required:
  --vm              VM hostname, e.g. demo-1

Environment fallbacks: SLICER_URL, SLICER_TOKEN, SLICER_HOST_GROUP`,
  );
  process.exit(2);
}

async function main() {
  const args = parseArgs();
  if (!args.url || !args.vm) usage();

  const client = new SlicerClient({
    baseURL: args.url,
    ...(args.token && { token: args.token }),
    userAgent: 'slicer-watch-example/1.0',
  });

  const vm = client.vms.attach(args.hostGroup, args.vm);

  const controller = new AbortController();
  const hardStop = setTimeout(() => controller.abort(), args.timeoutSec * 1000);
  hardStop.unref?.();
  const onSig = () => controller.abort();
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  process.stderr.write(
    `watching ${args.vm}:${args.path} (patterns=${JSON.stringify(args.patterns)}, timeout=${args.timeoutSec}s)\n`,
  );

  const binaries = new Map<string, number>();

  try {
    for await (const evt of vm.fs.watch({
      paths: [args.path],
      patterns: args.patterns,
      recursive: true,
      uid: args.uid,
    })) {
      if (controller.signal.aborted) break;

      // Go toolchain writes each output via <name>-go-tmp-umask + rename.
      // Suppress that noise unless -v is set; the interesting event is the
      // create on the final name.
      if (!args.verbose && evt.path.includes('-go-tmp-umask')) continue;

      switch (evt.type) {
        case 'create': {
          const name = path.basename(evt.path);
          const prev = binaries.get(evt.path);
          if (prev === undefined || prev !== evt.size) {
            binaries.set(evt.path, evt.size);
            console.log(
              `[${evt.id}] ${name.padEnd(28)} ${String(evt.size).padStart(10)} bytes  ${evt.timestamp}`,
            );
          }
          break;
        }
        case 'write':
        case 'chmod':
        case 'remove':
        case 'rename':
          if (args.verbose) {
            console.log(`[${evt.id}] ${(evt.type as string).padEnd(8)} ${evt.path} (${evt.size})`);
          }
          break;
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error('stream:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  } finally {
    clearTimeout(hardStop);
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }

  process.stderr.write(`\nfinal: ${binaries.size} binaries observed\n`);
  for (const [p, size] of binaries) {
    process.stderr.write(`  ${p} (${size} bytes)\n`);
  }
}

main().catch((err) => {
  console.error('error:', err instanceof Error ? err.message : err);
  process.exit(1);
});

// Silence unused-import warnings when tsc runs in isolation.
type _FSWatchEvent = FSWatchEvent;
