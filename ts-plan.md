# @slicervm/sdk — TypeScript SDK plan

Canonical reference: Go SDK at `~/go/src/github.com/slicervm/sdk`.
Daemon sources (fallback for route/wire details): Linux at `~/go/src/github.com/openfaasltd/slicer`, Mac at `~/go/src/github.com/openfaasltd/slicer-mac`.
Test targets: local Slicer-for-Mac at `~/slicer-mac/slicer.sock` (default) and Linux daemon at `http://192.168.1.14:8090` (via `SLICER_URL`/`SLICER_TOKEN`). Host group `sbox`. Tests override VM size to **1 vCPU / 1 GiB** and always delete VMs in `finally`/`afterAll`.

Terminology: Slicer primitives only — host groups, nodes/VMs, exec, fs, snapshots, suspend/restore/relaunch. No "sandbox" at this layer.

Shape: **grouped** `SlicerClient` with `hostGroups`, `vms`, `secrets` namespaces plus per-VM operations on a `VM` handle (`vm.exec`, `vm.fs.*`, `vm.pause/resume/suspend/restore/shutdown/relaunch/delete`, `vm.health/logs`, `vm.waitForAgent`). Inspired by `@e2b` and `modal-labs/libmodal` (not Vercel's flat shape — see "SDK shape decision" below). `Node` renamed to `VM` throughout the TS surface (the Go SDK uses "Node"; TS reads better as "VM"). TypeScript source, dual ESM+CJS build via tsup. Node 18+.

### SDK shape decision (2026-04-13)
Evaluated E2B, Modal, Vercel TS SDKs:
- **E2B**: nested instance — `sandbox.commands.run`, `sandbox.files.read`, `sandbox.pty.*`; static `Sandbox.create/connect/list`.
- **Modal**: namespaced top-level — `modal.sandboxes.*`, `modal.apps.*`; `sb.exec()` returns a process with stream accessors.
- **Vercel**: flat — `sandbox.runCommand`, `sandbox.readFile`, `sandbox.writeFiles`.

Slicer has both control-plane (host groups, VMs, stats, secrets) and per-VM ops; flat Vercel shape doesn't distinguish these and scales poorly. Adopted Modal/E2B hybrid: namespaced top-level + handle-based per-VM surface. `Node` → `VM` rename chosen explicitly (Alex, 2026-04-13): Go SDK uses "Node" for historical reasons; TS consumers expect "VM".

Checkbox convention: **(impl)** = code written + typechecks clean; **(tested e2e)** = ran against the live local daemon and passed. Items that diverge from the Go SDK because of daemon reality are noted inline.

## Scaffold
- [x] Repo layout at `~/go/src/github.com/slicervm/sdk-ts/`
- [x] `package.json` (dual exports, tsup, vitest)
- [x] `tsconfig.json` (strict, NodeNext)
- [x] `tsup.config.ts` (ESM + CJS + .d.ts)
- [x] `vitest.config.ts`
- [x] `.gitignore`, `README.md` skeleton
- [x] `npm install` succeeds

## Transport layer
- [x] Unix socket vs HTTP(S) URL resolution (impl)
- [x] `request()` buffered JSON + structured errors (impl)
- [x] `requestNDJSON()` streaming NDJSON via async generator (impl)
- [x] `requestRaw()` raw bytes for cp binary (impl)
- [x] `requestStreamRaw()` streaming body/response (for tar upload) (impl)
- [x] Bearer auth header when token set (impl)
- [x] Transport resolver unit tests pass
- [x] `GET /hostgroup` round-trip against live daemon (tested e2e, Mac + Linux)

## Types
- [x] `HostGroup`, `Node`, `CreateNodeRequest`, `CreateNodeResponse` (impl)
- [x] `AgentHealth`, `VMLogs`, `NodeStat`, `NodeSnapshot` (impl)
- [x] `ExecRequest`, `ExecFrame`, `ExecResult` (impl)
- [x] `FSEntry`, `FSMkdirRequest`, `FSRemoveRequest` (impl)
- [x] `ShutdownRequest`, `CreateNodeOptions`, `WaitOptions`, `ListOptions` (impl)
- [x] `Secret`, `CreateSecretRequest`, `UpdateSecretRequest` (impl)
- [x] `SlicerAPIError`, `SecretExistsError` (impl)
- [x] `MiB`, `GiB`, `NonRootUser` helpers (impl)

## Host groups
Daemon exposes read-only host groups — no CRUD routes in either Linux or Mac builds, so the SDK deliberately omits create/update/delete.
- [x] `listHostGroups()` — GET /hostgroup (impl)
- [x] `listHostGroups()` contains `sbox` (tested e2e, both)
- [x] `findHostGroup(name)` — derived from list (impl)
- [x] `listHostGroupNodes(name, opts?)` — GET /hostgroup/{name}/nodes (impl)
- [x] `listHostGroupNodes` returns array (tested e2e, both)

## VMs — lifecycle (renamed from Nodes)
- [x] `createNode(group, req, {wait, waitTimeoutSec})` — POST /hostgroup/{g}/nodes (impl)
- [x] `deleteNode(group, hostname)` (impl)
- [x] `listVMs(opts?)` — GET /nodes + tag/tag_prefix (impl)
- [x] `getNodeStats()` — GET /nodes/stats (impl)
- [x] `getVMLogs(hostname)` — GET /vm/{h}/logs (impl)
- [x] `agentHealth(hostname)` — GET /vm/{h}/health (impl)
- [x] `waitForAgent(hostname, opts)` client-side poller (impl)
- [x] `waitForUserdata(hostname, opts)` (impl)
- [x] `getInfo()` — GET /info (impl)
- [x] `getInfo` returns platform/arch (tested e2e, both)
- [x] create VM (1c/1G) → waitForAgent → delete (tested e2e, both)
- [x] create VM with server-side `wait=agent` (tested e2e, both; `timeout` serialised as Go duration `60s`)
- [x] `listVMs({tag})` returns the created VM (tested e2e, both)
- [x] `getNodeStats()` decodes into documented shape (tested e2e, both)
- [x] `getVMLogs()` returns hostname + content (tested e2e, both)
- [ ] `waitForUserdata` e2e (not covered — deferred, needs userdata script + agent signal)

## Power / snapshot ops
- [x] `shutdownVM(hostname)` (impl)
- [x] `pauseVM(hostname)` (impl)
- [x] `resumeVM(hostname)` (impl)
- [x] `suspendVM(hostname)` (impl)
- [x] `restoreVM(hostname)` (impl)
- [x] `relaunchVM(hostname)` (impl)
- [x] pause → resume roundtrip (tested e2e, both)
- [x] suspend → restore roundtrip (tested e2e, Mac; skipped on Linux — endpoint not present)
- [x] shutdown → relaunch roundtrip with `persistent: true` (tested e2e, Mac + Linux). Non-persistent VMs are auto-reaped by the health monitor and cannot be relaunched — this is expected behaviour (`handleSboxRelaunch` rejects non-persistent VMs with 409).

## Exec
- [x] `exec(hostname, req)` NDJSON stream via async generator (impl)
- [x] `execBuffered(hostname, req)` `?buffered=true` single JSON (impl — rejects `stdin` up-front, matching Go SDK)
- [x] stdin body support on streaming path (impl)
- [x] cwd, env, uid, gid, shell, permissions (impl)
- [x] `stdio: 'text' | 'base64'` on `ExecRequest` — binary-safe wire encoding (impl)
- [x] `execBuffered` auto-decodes base64 stdout/stderr into `Buffer` when `stdio: 'base64'`; overloaded return type `ExecResultBinary` (impl)
- [x] `exec` streaming populates `dataBytes` / `stdoutBytes` / `stderrBytes` on frames with `encoding === 'base64'` (impl)
- [x] pid / startedAt / endedAt / signal surfaced on `ExecResult` from SDK v0.0.42 wire fields (impl)
- [x] `execBuffered` runs `uname -a` (tested e2e, both)
- [x] `exec` streams `started` → `stdout` → `exit` frames in order (tested e2e, both)
- [x] `execBuffered` rejects `stdin` (tested e2e, both)
- [x] `exec` with env + cwd honored (tested e2e, both)
- [x] non-zero exit code surfaces on `execBuffered` (tested e2e, both)
- [x] `exec` (streaming) with stdin piped (tested e2e, Mac)
- [x] `execBuffered` `stdio: 'base64'` — 64 KiB random bytes byte-identical round-trip (tested e2e, Mac)
- [x] `exec` (streaming) `stdio: 'base64'` — 32 KiB random bytes reconstructed from frame Buffers (tested e2e, Mac)
- [x] Direct curl probe: ffmpeg `-c copy -f mpegts` transmux via `stdio=base64`, ffprobe verifies h264/320x240 stream integrity (tested)
- [x] Direct curl probe: 28 KiB MKV byte-exact cat round-trip, MD5 identical in/out (tested)

## Filesystem (native endpoints)
- [x] `readDir(hostname, path)` (impl)
- [x] `stat(hostname, path)` — returns `null` on 404 (impl)
- [x] `exists(hostname, path)` derived from stat (impl)
- [x] `mkdir(hostname, req)` — supports recursive + mode (impl)
- [x] `remove(hostname, path, recursive?)` (impl)
- [x] `readFile(hostname, path)` — `mode=binary` (impl)
- [x] `writeFile(hostname, path, bytes, opts?)` — `mode=binary` (impl)
- [x] mkdir → writeFile → stat → readFile → readDir → exists → remove (tested e2e, both)

## cp / tar
- [x] `readFile` / `writeFile` binary single-file (impl + tested e2e above)
- [x] `tarFromVM(hostname, path)` — GET /cp?mode=tar (impl)
- [x] `tarToVM(hostname, path, tar)` — POST /cp?mode=tar (impl; accepts Buffer or Readable)
- [x] `tarFromVM` returns a well-formed ustar archive (tested e2e, both)
- [ ] `tarToVM` round-trip with upload dir assertion (deferred — flow depends on daemon's exact extraction semantics, not needed for v0.1)
- [ ] Helper: pack a local directory into a tar stream (deferred — Node has no stdlib tar; add via optional dep or `node:zlib`+custom packer later)

## Secrets
- [x] `listSecrets()` (impl)
- [x] `createSecret(req)` — base64-encodes `data` before POST; throws `SecretExistsError` on 409 (impl)
- [x] `patchSecret(name, req)` (impl)
- [x] `deleteSecret(name)` (impl)
- [x] create → list → patch → delete roundtrip (tested e2e, Linux; skipped on Mac — endpoint not wired in Slicer-for-Mac)

## Integration
- [x] `tsc --noEmit` clean
- [x] `tsup` build produces ESM + CJS + `.d.ts` + `.d.cts`
- [x] `npm pack` dry-run clean (8 files, 32.6 kB tarball)
- [x] README with a worked example
- [ ] Full README method table (deferred — auto-generate from client.ts before publishing)
- [ ] Decision: refactor `@computesdk/slicer` onto `@slicervm/sdk` (follow-up, not this pass)

## Deferred (explicit)
- [ ] Port-forwarding (needs inlets port — out of scope for v0.1)
- [ ] Local tar packer helper (above — no stdlib option in Node)
- [ ] `waitForUserdata` e2e coverage

## Known daemon issues surfaced during porting
- **Linux stdin over exec** (daemon/agent bug — **fixed in slicer commit ea7ca3dc, ported to slicer-mac**): exit frame carries `http: invalid Read on closed Body`; child process sees empty/truncated stdin. Root cause: once a Go `http.Handler` begins writing the response, continued reads from `r.Body` are unsafe unless `http.NewResponseController(w).EnableFullDuplex()` is called first. Both hops need it: the daemon forwarder (`pkg/server.go` `proxyToAgentHTTP` pattern) and the agent handler (`slicer-agent/cmd/rpc_exec.go`). Triggered recently because the agent began emitting a typed `started` frame immediately after `cmd.Start()` — so the HTTP response starts flushing before the child has consumed stdin.

  **Why Mac currently "works" is not fully explained — and is probably accidental, not architectural.** Earlier sub-agent claim that `httputil.ReverseProxy` hijacks or auto-enables full-duplex is false: on Go 1.25.1, `httputil.ReverseProxy` does not call `EnableFullDuplex()` in the normal HTTP proxy path, and in any case Mac's direct exec path uses `proxyToAgentHTTP` with the same hand-rolled shape as Linux. More plausible: Mac's agent path doesn't emit the `started` frame early (or at all), so the child reads stdin to EOF before any response byte is written, sidestepping the full-duplex constraint. Once Mac adopts the typed-started-frame flow, it will need the same fix.

  SDK-side: streaming stdin test skipped on Linux; should be re-enabled (with a large payload to catch truncation) once both hops are patched.
- **Mac suspend/restore**: wired (tested e2e, works). Linux daemon has no `/suspend` or `/restore` route — the context note implied "Linux follows"; SDK methods exist but throw `SlicerAPIError 404` there.
- **Mac relaunch via shutdown→relaunch** (not a bug — docs gap): `handleSboxRelaunch` (api.go:1407) explicitly rejects non-persistent VMs with 409, and the health monitor (api.go:540-574, 15s cadence) reaps non-persistent stopped VMs out of `sboxVMs` — after which the route's VM lookup 404s. Correct flow: create with `persistent: true`, then shutdown → relaunch works. SDK `relaunchVM` is unchanged; the e2e now exercises the persistent-VM flow and passes on both daemons.
- **`timeout` query param**: daemon expects a Go duration string (`60s`), not a bare integer. SDK formats as `${seconds}s` automatically.
- **Secret `data` wire format**: Linux daemon requires base64-encoded data; Mac daemon has no secrets route at all. SDK base64-encodes transparently so callers pass plaintext.
- **Exit code 0 in streaming exec**: NDJSON `exit_code` is `omitempty`, so a clean exit has no `exit_code` field. Callers should detect the exit frame via `type === 'exit'`.
