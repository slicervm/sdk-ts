# k3s with port-forward

Provision a single-node K3s cluster inside a Slicer VM, then talk to its API from the host via `vm.forward(...)`.

What this exercises:

- **Userdata-driven cluster install** — k3s via [k3sup](https://github.com/alexellis/k3sup), installed at first boot using `arkade` (preinstalled in the slicer base image).
- **Server-side `wait: 'userdata'`** — `client.vms.create()` doesn't return until the cluster is ready, so the next line can immediately read the kubeconfig.
- **`vm.fs.readFile`** to pull `/home/ubuntu/.kube/config` out of the guest.
- **`vm.forward('127.0.0.1:0:127.0.0.1:6443')`** — TCP listener on a random local port, tunnelling to the API server over a per-connection WebSocket through the daemon.
- **Host-side `kubectl get nodes`** against a rewritten kubeconfig pointing at the local forward port — proof the API server is reachable end-to-end.

Mirrors the Go SDK's [`examples/k3s-userdata`](https://github.com/slicervm/sdk/tree/main/examples/k3s-userdata) but uses port-forwarding instead of guest-network IP rewriting, so it works the same on Slicer for Mac (where guest IPs aren't routable from the host) and Slicer for Linux.

## Prerequisites

- A running Slicer daemon.
- `kubectl` on the host (`arkade get kubectl` or any package manager).
- `SLICER_URL` (and `SLICER_TOKEN` on Linux) exported.

## Run

```bash
npm install
SLICER_URL=~/slicer-mac/slicer.sock npm start
```

Expected output (timings vary):

```
→ creating VM in sbox (waiting for userdata to finish k3s install)…
  VM sbox-1 (192.168.64.5) ready in 42.8s
→ reading kubeconfig from VM…
→ opening forward 127.0.0.1:0 → :6443…
  local port: 51234
→ kubectl get nodes (host-side, via port-forward)…
NAME      STATUS   ROLES                  AGE   VERSION
sbox-1    Ready    control-plane,master   18s   v1.30.x+k3s1
✓ k3s reachable from host in 49.2s total
→ deleting VM sbox-1…
```

## Notes

- The kubeconfig writes a self-signed CA tied to `127.0.0.1`. Because we forward through `127.0.0.1` on the host, the CA verifies cleanly. The script also passes `--insecure-skip-tls-verify` so the example works even if k3s ever changes the cert SANs.
- Userdata install can take 30–60 seconds the first time on each base image, dominated by `arkade` downloads.
- For repeat runs, [build a custom image](https://docs.slicervm.com/platform/custom-images/) with `k3sup` + `kubectl` baked in.
