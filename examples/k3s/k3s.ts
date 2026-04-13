/**
 * k3s e2e example for @slicervm/sdk.
 *
 * Mirrors the Go SDK's `examples/k3s-userdata` (`~/go/src/github.com/slicervm/sdk/examples/k3s-userdata`)
 * — same userdata script, same poll cadences, same overall flow — and adds a
 * port-forward to the API server so the host can reach kubectl over loopback
 * regardless of whether the guest network is routable.
 *
 * Flow:
 *   1. Create a VM with userdata that installs k3s via k3sup; block server-side
 *      on `wait: 'userdata'`. The daemon holds the response open via a single
 *      long-lived HTTP call to the in-guest agent's `/v1/health?wait=userdata`
 *      — no busy-polling, no probe storm during boot.
 *   2. From inside the VM, retry `kubectl get nodes` (as uid 1000) until k3s
 *      reports the node Ready — the agent is up before kube-apiserver is.
 *   3. Open a host-side port-forward to the VM's :6443.
 *   4. Pull the kubeconfig from the VM, rewrite `127.0.0.1:6443` → the local
 *      forward port, save to disk.
 *   5. Run host-side `kubectl get nodes` against the rewritten kubeconfig.
 *
 * The VM is left running so you can keep using kubectl after the script exits.
 * Delete it manually with: slicer vm delete <hostname> --hostgroup sbox
 *
 * Usage:
 *   SLICER_URL=~/slicer-mac/slicer.sock npx tsx k3s.ts
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SlicerClient, GiB, type VM } from '@slicervm/sdk';

const execFileP = promisify(execFile);

const USERDATA = `#!/bin/bash
set -euo pipefail

arkade get k3sup kubectl --path /usr/local/bin
chmod +x /usr/local/bin/*

if [ -x /usr/local/bin/k3sup ]; then
  export PATH="/usr/local/bin:\${PATH}"
fi

k3sup install --local
mkdir -p /home/ubuntu/.kube
cp kubeconfig /home/ubuntu/.kube/config
chown -R ubuntu:ubuntu /home/ubuntu/

k3sup ready --kubeconfig ./kubeconfig --pause 500ms --attempts 120
`;

async function main() {
  const totalStart = Date.now();
  const client = SlicerClient.fromEnv();
  const hostGroup = await resolveHostGroup(client);
  const tag = process.env.K3S_TAG ?? `k3s-${Math.floor(Date.now() / 1000)}`;

  const createStart = Date.now();
  const vm = await client.vms.create(
    hostGroup,
    { cpus: 2, ramBytes: GiB(2), userdata: USERDATA, tags: [tag] },
    { wait: 'userdata', waitTimeoutSec: 600 },
  );
  console.log(`phase=create_and_wait_userdata_ms elapsed=${Date.now() - createStart}`);
  console.log(`created VM: hostname=${vm.hostname} ip=${vm.ip} tag=${tag}`);

  const kubeStart = Date.now();
  const nodes = await waitForKubectlNodes(vm);
  console.log(`phase=kubectl_get_nodes_ms elapsed=${Date.now() - kubeStart}`);
  console.log(`kubectl get nodes output (in-VM):\n${nodes.trim()}`);

  // Host-side: port-forward + kubeconfig rewrite + run kubectl from the host.
  const fwdStart = Date.now();
  const fwd = await vm.forward('127.0.0.1:0:127.0.0.1:6443');
  const localPort = fwd.listeners[0]!.port!;

  const remote = (await vm.fs.readFile('/home/ubuntu/.kube/config')).toString('utf8');
  const rewritten = remote.replace(
    /server:\s*https:\/\/[^\s]+/g,
    `server: https://127.0.0.1:${localPort}`,
  );
  const kubeconfigPath = path.resolve(`./kubeconfig-${vm.hostname}.yaml`);
  await fs.writeFile(kubeconfigPath, rewritten, { mode: 0o600 });
  console.log(`phase=copy_kubeconfig_ms elapsed=${Date.now() - fwdStart}`);
  console.log(`kubeconfig saved: ${kubeconfigPath}`);
  console.log(`forward: 127.0.0.1:${localPort} → ${vm.hostname}:6443`);

  const hostKube = await execFileP(
    'kubectl',
    ['--kubeconfig', kubeconfigPath, '--insecure-skip-tls-verify', 'get', 'nodes', '-o', 'wide'],
    { timeout: 30_000 },
  );
  console.log(`kubectl get nodes (host-side, via port-forward):\n${hostKube.stdout.trim()}`);

  await fwd.close();

  console.log(`phase=total_ms elapsed=${Date.now() - totalStart}`);
  console.log(`\nVM left running. To use it again:`);
  console.log(`  KUBECONFIG=${kubeconfigPath} kubectl get nodes`);
  console.log(`  (re-open the forward first: \`slicer vm forward ${vm.hostname} -L ${localPort}:127.0.0.1:6443\`)`);
  console.log(`\nDelete with: slicer vm delete ${vm.hostname} --hostgroup ${hostGroup}`);
}

async function resolveHostGroup(client: SlicerClient): Promise<string> {
  const configured = process.env.SLICER_HOST_GROUP ?? 'vm';
  try {
    const info = await client.getInfo();
    if (info.platform?.toLowerCase() === 'darwin') return 'sbox';
  } catch (err) {
    console.log(`failed to resolve hostgroup from /info: ${(err as Error).message}`);
    console.log(`using configured host group: ${configured}`);
  }
  return configured;
}

/** Retry `kubectl get nodes` as uid 1000 until it returns output. */
async function waitForKubectlNodes(vm: VM): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const r = await vm.execBuffered({
      command: 'kubectl',
      args: ['get', 'nodes'],
      uid: 1000,
      gid: 1000,
    });
    if (r.exitCode === 0 && r.stdout.trim()) return r.stdout;
    if (attempt === 1 || attempt % 5 === 0) {
      console.log(`attempt ${attempt}: kubectl not ready yet (exit=${r.exitCode})`);
    }
    await sleep(1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
