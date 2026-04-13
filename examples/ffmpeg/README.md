# ffmpeg e2e example

Full lifecycle demo for `@slicervm/sdk`: create a microVM, install ffmpeg, transcode a video, and stream the binary result back — without an intermediate file on the guest disk.

Highlights what's distinct about the TypeScript SDK vs. running ffmpeg locally or via `ssh + scp`:

- **Grouped API** — `client.vms.create()` returns a `VM` handle; every operation hangs off it.
- **`vm.fs.writeFile`** — binary-safe upload via native fs endpoints.
- **`stdio: 'base64'`** — the transcoded MP4 comes back through `execBuffered` as a `Buffer`, not through a second file copy.
- **Automatic cleanup** — `vm.delete()` in `finally` even if ffmpeg fails.

## Prerequisites

- A running Slicer daemon (Linux or Mac).
- `SLICER_URL` (and `SLICER_TOKEN` on Linux) exported.
- An input video. If you don't have one:
  ```bash
  ffmpeg -f lavfi -i testsrc=duration=3:size=640x480:rate=24 \
         -c:v libx264 -pix_fmt yuv420p input.mkv
  ```

## Run

```bash
npm install
SLICER_URL=~/slicer-mac/slicer.sock npm start -- input.mkv output.mp4
```

Expected output:

```
→ input input.mkv (42318 bytes)
→ creating VM in host group "sbox" (2 vCPU, 2 GiB)…
  hostname=sbox-1 ip=192.168.64.5
→ installing ffmpeg…
→ uploading source file…
→ transcoding (H.264/AAC, 720p cap)…
  → 58204 bytes produced in 2.3s
→ wrote output.mp4 (58204 bytes)
→ deleting VM sbox-1…
```

## Speeding this up

Most of the wall time is the `apt install ffmpeg` step. For repeat runs, [build a custom image](https://docs.slicervm.com/platform/custom-images/) with ffmpeg baked in, or keep a persistent VM (`persistent: true` on `client.vms.create`) and reuse it.
