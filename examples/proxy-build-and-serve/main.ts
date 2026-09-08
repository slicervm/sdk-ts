/**
 * proxy-build-and-serve example for @slicervm/sdk.
 *
 * Demonstrates the slicer-proxy admin API alongside the VM, bg-exec, and
 * port-forward APIs. End-to-end story:
 *
 *   1. Mint a slicer-proxy access token (we choose the literal so it can
 *      be templated into VM userdata before the VM exists).
 *   2. Register the proxy client + the *absolute minimum* allow rules
 *      needed to bootstrap a Next.js project: apt mirrors, the github
 *      tarball endpoint, and the npm registry.
 *   3. Launch a VM whose ONLY egress is via slicer-proxy. Userdata
 *      enables the in-agent transparent proxy helper, installs
 *      node/npm/git, downloads alexellis/alexellis.io as a tarball,
 *      runs `npm ci`. Block on `wait=userdata` so this whole
 *      bootstrap phase is synchronous from the caller's POV.
 *   4. Start `npm run dev` as a slicer background exec (durable across
 *      client disconnect; output captured in a ring buffer).
 *   5. **Drop every proxy allow rule.** Egress is now fully closed —
 *      the dev server is already serving cached pages and doesn't need
 *      the internet anymore.
 *   6. Open a host-side port-forward → VM:3000 and curl through it.
 *      Assert the response is a Next.js page (status 200, looks like
 *      the alexellis.io homepage).
 *   7. Cleanup: stop the bg exec, delete the VM, delete the proxy
 *      client (which drops the rules we already drained).
 *
 * The arc is "tightly bounded build phase, then cut egress" — the
 * pattern an agent harness wants when it has to fetch dependencies
 * once and then run an isolated workload.
 *
 * Usage:
 *   SLICER_URL=./slicer.sock SLICER_HOST_GROUP=lab \
 *     PROXY_HOST=192.168.222.1 PROXY_PORT=3128 \
 *     npx tsx main.ts
 */

import { SlicerClient, GiB, type AddProxyAllowRequest, type VM } from '@slicervm/sdk';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const HOST_GROUP = process.env.SLICER_HOST_GROUP ?? 'lab';
const PROXY_HOST = process.env.PROXY_HOST ?? '192.168.222.1';
const PROXY_PORT = process.env.PROXY_PORT ?? '3128';

const PROXY_TOKEN = 'spt_' + randomBytes(32).toString('hex');
const PROXY_URL = `http://proxy:${PROXY_TOKEN}@${PROXY_HOST}:${PROXY_PORT}`;

const REPO_TARBALL = 'https://codeload.github.com/alexellis/alexellis.io/tar.gz/master';
const SITE_DIR = '/opt/site';
const SITE_PORT = 3000;
const HOST_FWD = '127.0.0.1:8081';

// Absolute minimum allow set for clone + apt + npm ci. Each rule is
// narrowed by host (and method/path where the upstream supports it).
function ruleFor(client: string): AddProxyAllowRequest[] {
  return [
    { client, host: 'archive.ubuntu.com', methods: ['GET'], paths: ['/ubuntu/*'] },
    { client, host: 'security.ubuntu.com', methods: ['GET'], paths: ['/ubuntu/*'] },
    { client, host: 'nodejs.org', methods: ['GET'], paths: ['/dist/*'] },
    { client, host: 'codeload.github.com', methods: ['GET'], paths: ['/alexellis/*'] },
    { client, host: 'cloudflare-dns.com', methods: ['POST'], paths: ['/dns-query'] },
    { client, host: 'registry.npmjs.org' },
    // sharp's native install hits jsdelivr / r2 prebuilt binaries.
    { client, host: '*.r2.cloudflarestorage.com' },
    { client, host: 'cdn.jsdelivr.net' },
    { client, host: 'github.com' },
    { client, host: '*.githubusercontent.com' },
  ];
}

const userdata = (): string => `#!/bin/bash
set -euo pipefail

HTTPS_PROXY=${JSON.stringify(PROXY_URL)} /usr/local/bin/slicer-agent proxy install
/usr/local/bin/slicer-agent proxy status

DEBIAN_FRONTEND=noninteractive apt-get update -qy
DEBIAN_FRONTEND=noninteractive apt-get install -qy --no-install-recommends curl ca-certificates xz-utils tar

# Ubuntu ships node 12, alexellis.io needs Next.js 14 -> node 18+.
NODE_VER=v20.18.1
curl -fsSL https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz \
  | tar -xJ -C /usr/local --strip-components=1
node --version >/var/log/node-version.txt
npm --version >>/var/log/node-version.txt

mkdir -p ${SITE_DIR}
curl -fsSL ${JSON.stringify(REPO_TARBALL)} | tar -xz --strip-components=1 -C ${SITE_DIR}

cd ${SITE_DIR}
ls -la >/var/log/site-listing.txt
# Node ignores the OS trust store; point it at slicer's MITM CA explicitly.
export NODE_EXTRA_CA_CERTS=$(ls /etc/ssl/certs/slicer-agent-*.pem | head -1)
echo "NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS" >>/var/log/node-version.txt
npm ci --no-audit --no-fund >/var/log/npm-install.log 2>&1

mkdir -p /etc/slicer
touch /etc/slicer/userdata-ran
`;

async function waitForListener(vm: VM, port: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await vm.execBuffered({
      command: '/bin/bash',
      args: ['-c', `(echo > /dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo up || echo down`],
    });
    if (r.stdout.trim() === 'up') return;
    await sleep(2000);
  }
  throw new Error(`port ${port} did not come up in ${timeoutMs}ms`);
}

async function main() {
  const t0 = Date.now();
  const client = SlicerClient.fromEnv();
  const clientName = `tsbuild-${Date.now()}`;
  const rules = ruleFor(clientName);

  console.log(`→ creating proxy client "${clientName}"`);
  const created = await client.proxy.clients.create(clientName, { token: PROXY_TOKEN });
  console.log(`  client minted: name=${created.name}`);

  let vm: VM | undefined;
  let bgExecId: string | undefined;

  try {
    console.log(`→ adding ${rules.length} build-phase allow rules`);
    for (const r of rules) {
      await client.proxy.allows.add(r);
      console.log(`  allow: ${r.host}${r.paths ? ' ' + (r.paths || []).join(',') : ''}`);
    }

    console.log(`→ launching VM in "${HOST_GROUP}", blocking on userdata (apt + clone + npm ci)…`);
    vm = await client.vms.create(
      HOST_GROUP,
      { cpus: 2, ramBytes: GiB(4), userdata: userdata() },
      { wait: 'userdata', waitTimeoutSec: 900 },
    );
    console.log(`  VM ${vm.hostname} ready in ${ms(Date.now() - t0)}`);

    console.log('→ inspecting site install (sanity check)');
    const ls = await vm.execBuffered({
      command: 'sh',
      args: ['-c', `ls -la ${SITE_DIR}/node_modules/.bin/next 2>&1; echo --; head -1 ${SITE_DIR}/package.json 2>&1`],
    });
    console.log(ls.stdout || ls.stderr);

    console.log('→ starting `next dev` as a background exec…');
    const bg = await vm.bg.exec({
      command: '/bin/bash',
      args: ['-lc', `cd ${SITE_DIR} && export NODE_EXTRA_CA_CERTS=$(ls /etc/ssl/certs/slicer-agent-*.pem | head -1) && exec ./node_modules/.bin/next dev --hostname 0.0.0.0 --port ${SITE_PORT}`],
      uid: 0,
      gid: 0,
      env: [`HOSTNAME=0.0.0.0`, `PORT=${SITE_PORT}`],
      ringBytes: 4 * 1024 * 1024,
    });
    bgExecId = bg.execId;
    console.log(`  bg exec started: id=${bg.execId} pid=${bg.pid}`);

    console.log(`→ waiting for :${SITE_PORT} listener inside VM…`);
    try {
      await waitForListener(vm, SITE_PORT, 120_000);
    } catch (e) {
      console.error('listener wait failed; dumping bg exec logs:');
      try {
        for await (const frame of vm.bg.logs(bgExecId, { follow: false })) {
          if (frame.stdout) process.stderr.write(`[stdout] ${frame.stdout}`);
          if (frame.stderr) process.stderr.write(`[stderr] ${frame.stderr}`);
        }
      } catch (le) {
        console.error('  (failed to fetch bg logs:', le, ')');
      }
      throw e;
    }
    console.log('  listener up');

    console.log('→ DROPPING ALL PROXY ALLOW RULES (egress now fully closed)');
    for (const r of rules) {
      await client.proxy.allows.removeByTuple(r);
    }
    const remaining = await client.proxy.clients.rules(clientName);
    if (remaining.length !== 0) {
      throw new Error(
        `expected zero proxy rules after lockdown, found ${remaining.length}: ${remaining.map((r) => r.host).join(', ')}`,
      );
    }
    console.log(`  rules remaining for ${clientName}: 0`);

    console.log(`→ opening forward ${HOST_FWD} → VM:${SITE_PORT}…`);
    const fwd = await vm.forward(`${HOST_FWD}:127.0.0.1:${SITE_PORT}`);
    try {
      console.log(`→ GET http://${HOST_FWD}/`);
      const res = await fetch(`http://${HOST_FWD}/`);
      const body = await res.text();
      console.log(`  status=${res.status} bytes=${body.length}`);
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      const looksLikeNext = body.includes('__next') || body.includes('_next/static') || body.toLowerCase().includes('alex');
      if (!looksLikeNext) {
        throw new Error(`response body did not look like the alexellis.io homepage; first 200 chars:\n${body.slice(0, 200)}`);
      }
      console.log('  ✓ alexellis.io served end-to-end via slicer-proxy + bg-exec + port-forward');
      console.log(`  total wall-clock: ${ms(Date.now() - t0)}`);
    } finally {
      await fwd.close();
    }
  } finally {
    if (process.env.KEEP_VM === '1' && vm) {
      console.log(`KEEP_VM=1 set: leaving ${vm.hostname} + proxy client "${clientName}" up for inspection`);
    } else {
      if (vm && bgExecId) {
        try { await vm.bg.kill(bgExecId, { signal: 'TERM', graceMs: 2000 }); } catch {}
      }
      if (vm) {
        try { await vm.delete(); } catch (e) { console.error('warn: vm.delete:', e); }
      }
      try { await client.proxy.clients.delete(clientName); } catch (e) { console.error('warn: client.delete:', e); }
    }
  }
}

const ms = (n: number) => (n / 1000).toFixed(1) + 's';

main().catch((e) => { console.error(e); process.exit(1); });
