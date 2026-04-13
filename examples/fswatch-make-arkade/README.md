# fswatch-make-arkade

TypeScript port of the Go SDK's [`watch-make-arkade-bin`](https://github.com/slicervm/sdk/tree/main/examples/watch-make-arkade-bin) example. Streams filesystem events from a microVM while `make dist` produces arkade cross-compiled binaries; prints one line per final binary as it lands on disk.

This example **attaches to an existing VM** — it does not create or delete one. Pair it with your own orchestration.

## Expected setup inside the VM

```bash
git clone https://github.com/alexellis/arkade ~/src/arkade
arkade system install go
```

## Run the watcher

```bash
npm install

SLICER_URL=https://slicer.example.com \
SLICER_TOKEN=... \
npm start -- --vm demo-1 --path /home/ubuntu/src/arkade/bin
```

Or against a local Slicer-for-Mac socket:

```bash
SLICER_URL=~/slicer-mac/slicer.sock \
npm start -- --vm sbox-1 --path /home/ubuntu/src/arkade/bin
```

## Trigger the build in another terminal

```bash
slicer vm exec demo-1 --uid 1000 -- \
  "cd ~/src/arkade && PATH=/usr/local/go/bin:\$PATH make dist"
```

## Expected output

Each produced binary prints a single line as its final name is created:

```
[42] arkade                           12345678 bytes  2026-04-13T19:58:01.234Z
[61] arkade-darwin                    13456789 bytes  2026-04-13T19:58:04.112Z
[79] arkade-darwin-arm64              13567890 bytes  2026-04-13T19:58:07.009Z
...

final: 6 binaries observed
  /home/ubuntu/src/arkade/bin/arkade (12345678 bytes)
  /home/ubuntu/src/arkade/bin/arkade-darwin (13456789 bytes)
  ...
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--vm`           | *(required)*                      | VM hostname to attach to |
| `--url`          | `$SLICER_URL`                     | Slicer API URL or unix socket path |
| `--token`        | `$SLICER_TOKEN`                   | Bearer token (optional for unix sockets) |
| `--host-group`   | `$SLICER_HOST_GROUP`, `sbox`      | Host group for `attach()` |
| `--path`         | `/home/ubuntu/src/arkade/bin`     | Directory inside the VM to watch |
| `--pattern`      | `arkade*`                         | Glob patterns (comma-separated) |
| `--uid`          | `1000`                            | UID the agent uses to resolve `~` in paths |
| `-v`, `--verbose`| off                               | Print every event including Go toolchain tmp churn |
| `--timeout`      | `600` (seconds)                   | Stop watching after this duration |

## Notes

- Go's toolchain writes each output via `<name>-go-tmp-umask` then renames to the final name. The example filters that churn by default (suppresses any event whose path contains `-go-tmp-umask`) so you see one clean line per binary. Use `-v` to print everything.
- The watch stays open until the process is interrupted (`SIGINT`/`SIGTERM`) or the `--timeout` elapses.
