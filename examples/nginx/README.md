# nginx + port-forward

Minimal port-forward demo: spin up a VM, install nginx via userdata, expose port 80 on the host as `127.0.0.1:8080`, and fetch the welcome page through the tunnel — all from a single TS script.

What this exercises:

- **`wait: 'userdata'`** — `client.vms.create()` blocks server-side until apt-install finishes, so the next line can fetch immediately.
- **`vm.forward('127.0.0.1:8080:127.0.0.1:80')`** — TCP listener on the host, tunnelled over a per-connection WebSocket through the daemon, dialled to nginx inside the guest.
- **Plain `fetch()` from the host** — confirms the bytes round-trip cleanly.

## Run

```bash
npm install
SLICER_URL=~/slicer-mac/slicer.sock npm start
```

Expected output (timings vary):

```
→ creating VM in "sbox" with nginx userdata (blocking on wait=userdata)…
  VM sbox-1 (192.168.64.3) ready in 14.2s
→ opening forward 127.0.0.1:8080 → VM:80…
  127.0.0.1:8080 → 127.0.0.1:80
→ GET http://127.0.0.1:8080/
  status=200 bytes=615
  ✓ welcome page served end-to-end via port-forward
→ deleting VM sbox-1…
done in 15.0s
```

## Notes

- The first run on a fresh `sbox-base.img` does an apt-update + install — usually 8–15s on a warm cache. Subsequent runs vary with apt mirror latency.
- For repeat runs, [build a custom image](https://docs.slicervm.com/platform/custom-images/) with nginx pre-installed.
