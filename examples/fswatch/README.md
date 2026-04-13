# fs watch (SSE) example

Open a Server-Sent Events stream of filesystem events from inside a Slicer VM and print them as they happen. The live-file-feedback use case — watching a build tool lay down binaries, or an agent LLM write source files, without polling `ls` on a loop.

What this exercises:

- **`vm.fs.watch(req)`** returns an `AsyncIterable<FSWatchEvent>`. Each `id`/`type`/`path`/`size` comes straight from the agent via the daemon over a long-lived SSE connection.
- **`wait: 'userdata'`** blocks `create()` until the guest has `/tmp/build-out` ready, so the watch subscribes against a populated VM.
- **A fake build** (`dd if=/dev/urandom`) emits 5 files with 250ms gaps, exactly the kind of staccato write pattern real toolchains produce.

## Run

```bash
npm install
SLICER_URL=~/slicer-mac/slicer.sock npm start
```

Expected output:

```
→ creating VM…
  sbox-1 ready
→ opening fs watch on /tmp/build-out…
→ running fake build (emits 5 files with 250ms gaps)…
[watch] id=1 create /tmp/build-out/artifact-1.bin (16384B)
[watch] id=2 create /tmp/build-out/artifact-2.bin (32768B)
[watch] id=3 create /tmp/build-out/artifact-3.bin (49152B)
[watch] id=4 create /tmp/build-out/artifact-4.bin (65536B)
[watch] id=5 create /tmp/build-out/artifact-5.bin (81920B)
→ captured 5 event(s) live from the guest filesystem.
→ deleting sbox-1…
```

## API shape

```ts
for await (const e of vm.fs.watch({
  paths: ['/tmp/build-out'],
  recursive: true,
  events: ['create', 'write'],          // optional filter; default = all
  patterns: ['*.bin'],                  // optional glob filter
  debounce: '100ms',                    // optional coalescing window
  timeout: '5m',                        // optional server-side cap
  maxEvents: 100,                       // optional hard stop
})) {
  console.log(e.type, e.path, e.size, e.isDir);
}
```

Break out of the loop to close the stream. `lastEventId` is accepted for forward-compatible cross-connection resume (the server currently validates but does not replay).
