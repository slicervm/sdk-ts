# run-command

Minimal end-to-end example: create a microVM, run `uname -a`, delete the VM.

If `@slicervm/sdk` does anything for you, you can do it from this example by changing one method call. It's the canonical hello-world.

## Run

```bash
npm install
SLICER_URL=~/slicer-mac/slicer.sock npm start
```

For a remote daemon:

```bash
SLICER_URL=https://slicer.example.com \
SLICER_TOKEN=... \
npm start
```

Expected output:

```
created sbox-1 (192.168.64.5)
exit=0
Linux sbox-1 6.12.70 #1 SMP Sat Mar 14 09:14:48 UTC 2026 aarch64 aarch64 aarch64 GNU/Linux
deleted sbox-1
```

## What's happening

1. **`client.vms.create(...)` with `wait: 'agent'`** — the daemon holds the response open until the in-guest agent is reachable, so the next line can immediately run a command.
2. **`vm.execBuffered({ command, args })`** — runs the command and waits for it to exit, returning a single `{ stdout, stderr, exitCode }` result.
3. **`vm.delete()` in a `finally`** — ensures the VM is cleaned up even if the command throws.
