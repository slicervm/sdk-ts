/**
 * VM handle — returned from `client.vms.create()` / `client.vms.get()`.
 * Exposes per-VM operations (exec, fs, power, lifecycle).
 */

import { Readable } from 'node:stream';
import type { TransportClient } from './transport.js';
import { Forwarder, type ForwarderOptions } from './forward.js';
import {
  type AgentHealth,
  type BgDeleteResponse,
  type BgExecInfo,
  type BgExecRequest,
  type BgExecResponse,
  type BgKillOptions,
  type BgKillResponse,
  type BgLogOptions,
  type BgWaitExitResponse,
  type ExecFrame,
  type ExecRequest,
  type ExecStdio,
  type ExecResult,
  type ExecResultBinary,
  type FSEntry,
  type FSMkdirRequest,
  type FSWatchEvent,
  type FSWatchRequest,
  type ShutdownRequest,
  SlicerAPIError,
  type VMLogs,
  type WaitOptions,
} from './types.js';
import {
  agentHealthFromWire,
  fsEntryFromWire,
  type WireAgentHealth,
  type WireFSInfo,
} from './wire.js';

/** Per-VM filesystem operations. */
export class VMFileSystem {
  constructor(
    private readonly transport: TransportClient,
    private readonly hostname: string,
  ) {}

  async readDir(path: string): Promise<FSEntry[]> {
    const q = new URLSearchParams({ path });
    const wire = await this.transport.request<WireFSInfo[]>(
      'GET',
      `/vm/${encodeURIComponent(this.hostname)}/fs/readdir?${q.toString()}`,
    );
    return (wire ?? []).map(fsEntryFromWire);
  }

  async stat(path: string): Promise<FSEntry | null> {
    const q = new URLSearchParams({ path });
    try {
      const wire = await this.transport.request<WireFSInfo>(
        'GET',
        `/vm/${encodeURIComponent(this.hostname)}/fs/stat?${q.toString()}`,
      );
      return fsEntryFromWire(wire);
    } catch (err) {
      if (err instanceof SlicerAPIError && err.status === 404) return null;
      throw err;
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
  }

  async mkdir(req: FSMkdirRequest): Promise<void> {
    await this.transport.request(
      'POST',
      `/vm/${encodeURIComponent(this.hostname)}/fs/mkdir`,
      {
        path: req.path,
        ...(req.recursive !== undefined && { recursive: req.recursive }),
        ...(req.mode !== undefined && { mode: req.mode }),
      },
    );
  }

  async remove(path: string, recursive = false): Promise<void> {
    const q = new URLSearchParams({ path, recursive: String(recursive) });
    await this.transport.request(
      'DELETE',
      `/vm/${encodeURIComponent(this.hostname)}/fs/remove?${q.toString()}`,
    );
  }

  async readFile(path: string): Promise<Buffer> {
    const q = new URLSearchParams({ path, mode: 'binary' });
    return this.transport.requestRaw(
      'GET',
      `/vm/${encodeURIComponent(this.hostname)}/cp?${q.toString()}`,
    );
  }

  async writeFile(
    path: string,
    content: Buffer | string,
    opts: { uid?: number; gid?: number; permissions?: string } = {},
  ): Promise<void> {
    const q = new URLSearchParams({ path, mode: 'binary' });
    if (opts.uid !== undefined) q.set('uid', String(opts.uid));
    if (opts.gid !== undefined) q.set('gid', String(opts.gid));
    if (opts.permissions) q.set('permissions', opts.permissions);
    const body = typeof content === 'string' ? Buffer.from(content) : content;
    await this.transport.requestRaw(
      'POST',
      `/vm/${encodeURIComponent(this.hostname)}/cp?${q.toString()}`,
      body,
    );
  }

  /** Upload a tar archive, expanded into the VM at `path`. */
  async tarTo(path: string, tar: Buffer | Readable): Promise<void> {
    const q = new URLSearchParams({ path, mode: 'tar' });
    if (tar instanceof Buffer) {
      await this.transport.requestRaw(
        'POST',
        `/vm/${encodeURIComponent(this.hostname)}/cp?${q.toString()}`,
        tar,
        'application/x-tar',
      );
      return;
    }
    const res = await this.transport.requestStreamRaw(
      'POST',
      `/vm/${encodeURIComponent(this.hostname)}/cp?${q.toString()}`,
      tar,
      'application/x-tar',
    );
    for await (const _ of res as AsyncIterable<Buffer>) void _;
  }

  /**
   * Open a Server-Sent Events stream of filesystem events from the VM.
   * Yields one `FSWatchEvent` per agent-side event. The stream stays open
   * until the supplied request's `timeout` / `maxEvents` is hit, the daemon
   * tears it down, or the caller breaks out of the loop.
   *
   * Heartbeat SSE comments and named `event:` lines are silently dropped.
   *
   * Example:
   * ```ts
   * for await (const e of vm.fs.watch({ paths: ['/tmp'], recursive: true })) {
   *   console.log(e.type, e.path);
   * }
   * ```
   */
  async *watch(req: FSWatchRequest): AsyncGenerator<FSWatchEvent, void, void> {
    if (!req.paths || req.paths.length === 0) {
      throw new Error('vm.fs.watch: paths is required');
    }
    const q = new URLSearchParams();
    for (const p of req.paths) if (p) q.append('paths', p);
    for (const p of req.patterns ?? []) if (p) q.append('patterns', p);
    for (const e of req.events ?? []) if (e) q.append('events', e);
    if (req.uid !== undefined && req.uid !== 0) q.set('uid', String(req.uid));
    if (req.recursive) q.set('recursive', 'true');
    if (req.oneShot) q.set('one_shot', 'true');
    if (req.debounce) q.set('debounce', req.debounce);
    if (req.timeout) q.set('timeout', req.timeout);
    if (req.maxEvents !== undefined && req.maxEvents > 0) {
      q.set('max_events', String(req.maxEvents));
    }

    const extraHeaders: Record<string, string> = { Accept: 'text/event-stream' };
    if (req.lastEventId) extraHeaders['Last-Event-ID'] = req.lastEventId;

    const res = await this.transport.requestStreamRaw(
      'GET',
      `/vm/${encodeURIComponent(this.hostname)}/fs/watch?${q.toString()}`,
      undefined,
      undefined,
      extraHeaders,
    );

    res.setEncoding('utf8');
    let buffer = '';
    let dataLines: string[] = [];
    let pendingId = 0;

    for await (const chunk of res as AsyncIterable<string>) {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line === '') {
          if (dataLines.length > 0) {
            const payload = dataLines.join('\n');
            dataLines = [];
            try {
              const parsed = JSON.parse(payload) as Partial<FSWatchEvent>;
              const evt: FSWatchEvent = {
                id: typeof parsed.id === 'number' && parsed.id !== 0 ? parsed.id : pendingId,
                type: parsed.type ?? '',
                path: parsed.path ?? '',
                timestamp: parsed.timestamp ?? '',
                size: parsed.size ?? 0,
                isDir: parsed.isDir ?? false,
                ...(parsed.message !== undefined && { message: parsed.message }),
              };
              yield evt;
            } catch {
              /* skip malformed payload */
            }
          }
        } else if (line.startsWith(':')) {
          /* heartbeat comment, ignore */
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        } else if (line.startsWith('id:')) {
          const v = parseInt(line.slice(3).trim(), 10);
          if (!Number.isNaN(v)) pendingId = v;
        }
        /* `event:` lines ignored — the server only uses one event type. */
      }
    }
  }

  /** Download `path` from the VM as a tar archive. */
  async tarFrom(path: string): Promise<Buffer> {
    const q = new URLSearchParams({ path, mode: 'tar' });
    return this.transport.requestRaw(
      'GET',
      `/vm/${encodeURIComponent(this.hostname)}/cp?${q.toString()}`,
    );
  }
}

export interface VMInit {
  hostname: string;
  hostGroup: string;
  ip?: string;
  createdAt?: string;
  arch?: string;
}

export class VM {
  readonly hostname: string;
  readonly hostGroup: string;
  readonly ip?: string;
  readonly createdAt?: string;
  readonly arch?: string;
  readonly fs: VMFileSystem;
  readonly bg: VMBg;

  private readonly transport: TransportClient;

  constructor(transport: TransportClient, init: VMInit) {
    this.transport = transport;
    this.hostname = init.hostname;
    this.hostGroup = init.hostGroup;
    if (init.ip !== undefined) this.ip = init.ip;
    if (init.createdAt !== undefined) this.createdAt = init.createdAt;
    if (init.arch !== undefined) this.arch = init.arch;
    this.fs = new VMFileSystem(transport, this.hostname);
    this.bg = new VMBg(transport, this.hostname);
  }

  // --- lifecycle --------------------------------------------------------

  async delete(): Promise<void> {
    await this.transport.request(
      'DELETE',
      `/hostgroup/${encodeURIComponent(this.hostGroup)}/nodes/${encodeURIComponent(
        this.hostname,
      )}`,
    );
  }

  // --- health / logs ----------------------------------------------------

  async health(): Promise<AgentHealth> {
    const wire = await this.transport.request<WireAgentHealth>(
      'GET',
      `/vm/${encodeURIComponent(this.hostname)}/health`,
    );
    return agentHealthFromWire(wire);
  }

  async logs(): Promise<VMLogs> {
    return this.transport.request<VMLogs>('GET', `/vm/${encodeURIComponent(this.hostname)}/logs`);
  }

  async waitForAgent(opts: WaitOptions = {}): Promise<AgentHealth> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const intervalMs = opts.intervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.health();
      } catch (err) {
        lastErr = err;
        await sleep(intervalMs);
      }
    }
    throw new Error(
      `agent for ${this.hostname} did not become ready within ${timeoutMs}ms: ${errMsg(lastErr)}`,
    );
  }

  async waitForUserdata(opts: WaitOptions = {}): Promise<AgentHealth> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const intervalMs = opts.intervalMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    let last: AgentHealth | undefined;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        last = await this.health();
        if (last.userdataRan) return last;
      } catch (err) {
        lastErr = err;
      }
      await sleep(intervalMs);
    }
    throw new Error(
      `userdata for ${this.hostname} did not complete within ${timeoutMs}ms${
        lastErr ? `: ${errMsg(lastErr)}` : ''
      }`,
    );
  }

  // --- power ------------------------------------------------------------

  async shutdown(req: ShutdownRequest = {}): Promise<void> {
    await this.transport.request(
      'POST',
      `/vm/${encodeURIComponent(this.hostname)}/shutdown`,
      req,
    );
  }

  async pause(): Promise<void> {
    await this.transport.request('POST', `/vm/${encodeURIComponent(this.hostname)}/pause`);
  }

  async resume(): Promise<void> {
    await this.transport.request('POST', `/vm/${encodeURIComponent(this.hostname)}/resume`);
  }

  async relaunch(): Promise<void> {
    await this.transport.request('POST', `/vm/${encodeURIComponent(this.hostname)}/relaunch`);
  }

  /** Mac-only on current daemons. Throws `SlicerAPIError 404` on Linux. */
  async suspend(): Promise<void> {
    await this.transport.request('POST', `/vm/${encodeURIComponent(this.hostname)}/suspend`);
  }

  /** Mac-only on current daemons. Throws `SlicerAPIError 404` on Linux. */
  async restore(): Promise<void> {
    await this.transport.request('POST', `/vm/${encodeURIComponent(this.hostname)}/restore`);
  }

  // --- port forwarding ---------------------------------------------------

  /**
   * Open one or more port forwards from the host to this VM. Each spec follows
   * the same syntax as `slicer vm forward -L`:
   *
   *   `127.0.0.1:9000`              — listen and forward on the same TCP port
   *   `8081:127.0.0.1:8080`         — listen on `0.0.0.0:8081`, forward to `127.0.0.1:8080`
   *   `0.0.0.0:8080:127.0.0.1:8080` — fully explicit
   *   `9000:/var/run/docker.sock`   — TCP listen, Unix socket forward
   *   `/tmp/docker.sock:/var/run/docker.sock` — Unix-to-Unix
   *
   * Returns a {@link Forwarder} handle. Call `forwarder.close()` to tear down
   * all listeners and any in-flight tunnel sockets.
   */
  async forward(specs: string | string[], options?: ForwarderOptions): Promise<Forwarder> {
    return Forwarder.start({
      hostname: this.hostname,
      transport: this.transport.transport,
      ...(this.transport.token !== undefined && { token: this.transport.token }),
      userAgent: this.transport.userAgent,
      specs: typeof specs === 'string' ? [specs] : specs,
      ...(options !== undefined && { options }),
    });
  }

  // --- exec -------------------------------------------------------------

  /**
   * Streaming exec — yields NDJSON frames (`started`, `stdout`, `stderr`, `exit`).
   * When `req.stdio === 'base64'`, each frame's `data`/`stdout`/`stderr` string
   * fields are preserved as-is (base64-encoded) and the SDK populates decoded
   * `dataBytes`/`stdoutBytes`/`stderrBytes` Buffers alongside for convenience.
   */
  async *exec(req: ExecRequest): AsyncGenerator<ExecFrame, void, void> {
    const { path, body } = buildExecPath(this.hostname, req, false);
    for await (const raw of this.transport.requestNDJSON<WireExecFrame>('POST', path, body)) {
      const frame = normalizeExecFrame(raw);
      if (frame.encoding === 'base64') {
        if (frame.data) frame.dataBytes = Buffer.from(frame.data, 'base64');
        if (frame.stdout) frame.stdoutBytes = Buffer.from(frame.stdout, 'base64');
        if (frame.stderr) frame.stderrBytes = Buffer.from(frame.stderr, 'base64');
      }
      yield frame;
    }
  }

  /**
   * Buffered exec via `?buffered=true`. stdin is intentionally unsupported
   * (matches Go SDK `ExecBuffered`); use `exec()` for stdin cases.
   *
   * When `req.stdio === 'base64'`, stdout/stderr are decoded from base64 and
   * returned as `Buffer` — use this for binary output. Otherwise the result
   * carries UTF-8 strings.
   */
  execBuffered(req: ExecRequest & { stdio: 'base64' }): Promise<ExecResultBinary>;
  execBuffered(req: ExecRequest): Promise<ExecResult>;
  async execBuffered(req: ExecRequest): Promise<ExecResult | ExecResultBinary> {
    if (req.stdin !== undefined) {
      throw new Error('stdin is not supported by execBuffered; use exec() instead');
    }
    const { path, body } = buildExecPath(this.hostname, req, true);
    const raw = await this.transport.requestRaw('POST', path, body);
    const text = raw.toString('utf8');
    const parsed = text
      ? (JSON.parse(text) as {
          stdout?: string;
          stderr?: string;
          encoding?: 'text' | 'base64';
          pid?: number;
          started_at?: string;
          ended_at?: string;
          signal?: string;
          exit_code?: number;
          error?: string;
        })
      : {};

    const common = {
      exitCode: parsed.exit_code ?? 0,
      ...(parsed.pid !== undefined && { pid: parsed.pid }),
      ...(parsed.started_at !== undefined && { startedAt: parsed.started_at }),
      ...(parsed.ended_at !== undefined && { endedAt: parsed.ended_at }),
      ...(parsed.signal !== undefined && { signal: parsed.signal }),
      ...(parsed.error !== undefined && { error: parsed.error }),
    };

    if (req.stdio === 'base64' || parsed.encoding === 'base64') {
      return {
        stdout: Buffer.from(parsed.stdout ?? '', 'base64'),
        stderr: Buffer.from(parsed.stderr ?? '', 'base64'),
        encoding: 'base64',
        ...common,
      } satisfies ExecResultBinary;
    }
    return {
      stdout: parsed.stdout ?? '',
      stderr: parsed.stderr ?? '',
      ...(parsed.encoding !== undefined && { encoding: parsed.encoding }),
      ...common,
    } satisfies ExecResult;
  }
}

/**
 * WireExecFrame mirrors the JSON shape the server emits on the NDJSON exec
 * stream. Field names are snake_case to match the wire; `normalizeExecFrame`
 * maps them to the camelCase `ExecFrame` public type.
 */
interface WireExecFrame {
  timestamp?: string;
  type?: string;
  pid?: number;
  encoding?: ExecStdio;
  data?: string;
  started_at?: string;
  ended_at?: string;
  signal?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  error?: string;
}

function normalizeExecFrame(raw: WireExecFrame): ExecFrame {
  const frame: ExecFrame = {};
  if (raw.timestamp !== undefined) frame.timestamp = raw.timestamp;
  if (raw.type !== undefined) frame.type = raw.type;
  if (raw.pid !== undefined) frame.pid = raw.pid;
  if (raw.encoding !== undefined) frame.encoding = raw.encoding;
  if (raw.data !== undefined) frame.data = raw.data;
  if (raw.started_at !== undefined) frame.startedAt = raw.started_at;
  if (raw.ended_at !== undefined) frame.endedAt = raw.ended_at;
  if (raw.signal !== undefined) frame.signal = raw.signal;
  if (raw.stdout !== undefined) frame.stdout = raw.stdout;
  if (raw.stderr !== undefined) frame.stderr = raw.stderr;
  if (raw.exit_code !== undefined) frame.exitCode = raw.exit_code;
  if (raw.error !== undefined) frame.error = raw.error;
  return frame;
}

function buildExecPath(
  hostname: string,
  req: ExecRequest,
  buffered: boolean,
): { path: string; body: Buffer | undefined } {
  const q = new URLSearchParams();
  if (req.command) q.set('cmd', req.command);
  for (const a of req.args ?? []) q.append('args', a);
  for (const e of req.env ?? []) q.append('env', e);
  if (req.uid !== undefined) q.set('uid', String(req.uid));
  if (req.gid !== undefined) q.set('gid', String(req.gid));
  if (req.cwd) q.set('cwd', req.cwd);
  if (req.shell) q.set('shell', req.shell);
  if (req.permissions) q.set('permissions', req.permissions);
  if (req.stdio) q.set('stdio', req.stdio);
  if (buffered) q.set('buffered', 'true');
  let body: Buffer | undefined;
  if (req.stdin !== undefined) {
    q.set('stdin', 'true');
    body = typeof req.stdin === 'string' ? Buffer.from(req.stdin) : req.stdin;
  }
  return {
    path: `/vm/${encodeURIComponent(hostname)}/exec?${q.toString()}`,
    body,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Background exec — `vm.bg.*`
// ---------------------------------------------------------------------------

/**
 * Per-VM background-exec operations. A bg exec is detached at launch (its own
 * session leader), survives client disconnect, and writes stdout/stderr into a
 * per-process ring buffer on the agent. Manage one with the `execId` returned
 * from `exec()` plus `info`, `logs`, `kill`, `wait`, `remove`. The ring stays
 * allocated after the child exits — call `remove()` to free its budget.
 */
export class VMBg {
  constructor(
    private readonly transport: TransportClient,
    private readonly hostname: string,
  ) {}

  /**
   * Launch a long-running process. `command` + `args` is the deterministic
   * exec form (no shell). Set `shell: '/bin/bash'` (or similar) to opt in
   * to shell semantics — `$VAR` expansion, globs, `&&`/`||`, etc.
   */
  async exec(req: BgExecRequest): Promise<BgExecResponse> {
    if (!req.command) throw new Error('vm.bg.exec: command is required');
    const q = new URLSearchParams();
    q.set('background', 'true');
    q.set('cmd', req.command);
    for (const a of req.args ?? []) q.append('args', a);
    for (const e of req.env ?? []) q.append('env', e);
    // Serialize uid/gid whenever the caller provided them — including 0.
    // Omitting 0 would collide with the agent's "auto-detect non-root" path
    // (see resolveUIDGID in slicer-agent), silently demoting requests for
    // root to ubuntu. Leave the field off only when the caller didn't set it.
    if (req.uid !== undefined) q.set('uid', String(req.uid));
    if (req.gid !== undefined) q.set('gid', String(req.gid));
    if (req.shell) q.set('shell', req.shell);
    if (req.cwd) q.set('cwd', req.cwd);
    if (req.ringBytes !== undefined && req.ringBytes > 0) {
      q.set('ring_bytes', String(req.ringBytes));
    }
    q.set('stdio', 'base64');
    const path = `/vm/${encodeURIComponent(this.hostname)}/exec?${q.toString()}`;
    const wire = await this.transport.request<WireBgExecResponse>('POST', path);
    return bgExecResponseFromWire(wire);
  }

  /** All background execs the agent currently tracks (running + exited-not-reaped). */
  async list(): Promise<BgExecInfo[]> {
    const wire = await this.transport.request<WireBgExecInfo[]>(
      'GET',
      `/vm/${encodeURIComponent(this.hostname)}/exec`,
    );
    return (wire ?? []).map(bgExecInfoFromWire);
  }

  /** Latest status snapshot for one bg exec. Throws 404 if reaped or never existed. */
  async info(execId: string): Promise<BgExecInfo> {
    const wire = await this.transport.request<WireBgExecInfo>(
      'GET',
      `/vm/${encodeURIComponent(this.hostname)}/exec/${encodeURIComponent(execId)}`,
    );
    return bgExecInfoFromWire(wire);
  }

  /**
   * NDJSON log stream. Yields one frame per log line — `started`, `stdout`,
   * `stderr`, `exit`, plus optional `gap` frames if the ring evicted history
   * before the requested cursor. Frames carry `data` base64-encoded; the SDK
   * also populates `dataBytes` / `stdoutBytes` / `stderrBytes` Buffers.
   *
   * `follow: false` (default) replays from the cursor and ends when the ring
   * is drained. `follow: true` keeps the stream open until the child exits or
   * the caller breaks out.
   */
  async *logs(execId: string, opts: BgLogOptions = {}): AsyncGenerator<ExecFrame, void, void> {
    const q = new URLSearchParams();
    if (opts.follow) q.set('follow', 'true');
    if (opts.fromId !== undefined && opts.fromId > 0) q.set('from_id', String(opts.fromId));
    const path =
      `/vm/${encodeURIComponent(this.hostname)}/exec/${encodeURIComponent(execId)}/logs` +
      (q.toString() ? `?${q.toString()}` : '');
    for await (const raw of this.transport.requestNDJSON<WireExecFrame>('GET', path)) {
      const frame = normalizeExecFrame(raw);
      if (frame.encoding === 'base64') {
        if (frame.data) frame.dataBytes = Buffer.from(frame.data, 'base64');
        if (frame.stdout) frame.stdoutBytes = Buffer.from(frame.stdout, 'base64');
        if (frame.stderr) frame.stderrBytes = Buffer.from(frame.stderr, 'base64');
      }
      yield frame;
    }
  }

  /**
   * Signal a running bg exec. Default: SIGTERM with a 5 s grace period before
   * the agent escalates to SIGKILL. No-op (running=false) if the child has
   * already exited.
   */
  async kill(execId: string, opts: BgKillOptions = {}): Promise<BgKillResponse> {
    const body: Record<string, unknown> = {};
    if (opts.signal) body.signal = opts.signal;
    if (opts.graceMs !== undefined) body.grace_ms = opts.graceMs;
    const wire = await this.transport.request<WireBgKillResponse>(
      'POST',
      `/vm/${encodeURIComponent(this.hostname)}/exec/${encodeURIComponent(execId)}/kill`,
      body,
    );
    return bgKillResponseFromWire(wire);
  }

  /**
   * Long-poll until the child exits or `timeoutSec` elapses. Returns
   * `timedOut: true` if the deadline hit. Server default for `timeoutSec=0`
   * is 30 s.
   */
  async wait(execId: string, timeoutSec = 0): Promise<BgWaitExitResponse> {
    const q = new URLSearchParams();
    if (timeoutSec > 0) q.set('timeout', String(timeoutSec));
    const path =
      `/vm/${encodeURIComponent(this.hostname)}/exec/${encodeURIComponent(execId)}/wait-exit` +
      (q.toString() ? `?${q.toString()}` : '');
    const wire = await this.transport.request<WireBgWaitExitResponse>('GET', path);
    return bgWaitExitFromWire(wire);
  }

  /**
   * Reap a bg exec's ring buffer + registry entry. Does NOT kill a running
   * process — pair with `kill()` for "stop and clean up". After remove,
   * info/logs/kill/wait return 410 Gone.
   */
  async remove(execId: string): Promise<BgDeleteResponse> {
    const wire = await this.transport.request<WireBgDeleteResponse>(
      'DELETE',
      `/vm/${encodeURIComponent(this.hostname)}/exec/${encodeURIComponent(execId)}`,
    );
    return bgDeleteFromWire(wire);
  }
}

// ----- bg wire mapping -----------------------------------------------------

interface WireBgExecResponse {
  exec_id: string;
  pid: number;
  started_at: string;
  ring_bytes: number;
}
interface WireBgExecInfo {
  exec_id: string;
  pid: number;
  command: string;
  args?: string[];
  cwd?: string;
  uid?: number;
  started_at: string;
  running: boolean;
  exit_code?: number;
  signal?: string;
  ended_at?: string;
  bytes_written: number;
  bytes_dropped: number;
  next_id: number;
  ring_bytes: number;
}
interface WireBgKillResponse {
  exec_id: string;
  pid: number;
  running: boolean;
  signal_sent: string;
}
interface WireBgWaitExitResponse {
  exec_id: string;
  running: boolean;
  exit_code?: number;
  signal?: string;
  ended_at?: string;
  timed_out: boolean;
}
interface WireBgDeleteResponse {
  exec_id: string;
  reaped: boolean;
}

function bgExecResponseFromWire(w: WireBgExecResponse): BgExecResponse {
  return {
    execId: w.exec_id,
    pid: w.pid,
    startedAt: w.started_at,
    ringBytes: w.ring_bytes,
  };
}

function bgExecInfoFromWire(w: WireBgExecInfo): BgExecInfo {
  const out: BgExecInfo = {
    execId: w.exec_id,
    pid: w.pid,
    command: w.command,
    startedAt: w.started_at,
    running: w.running,
    bytesWritten: w.bytes_written,
    bytesDropped: w.bytes_dropped,
    nextId: w.next_id,
    ringBytes: w.ring_bytes,
  };
  if (w.args !== undefined) out.args = w.args;
  if (w.cwd !== undefined) out.cwd = w.cwd;
  if (w.uid !== undefined) out.uid = w.uid;
  if (w.exit_code !== undefined) out.exitCode = w.exit_code;
  if (w.signal !== undefined) out.signal = w.signal;
  if (w.ended_at !== undefined) out.endedAt = w.ended_at;
  return out;
}

function bgKillResponseFromWire(w: WireBgKillResponse): BgKillResponse {
  return {
    execId: w.exec_id,
    pid: w.pid,
    running: w.running,
    signalSent: w.signal_sent,
  };
}

function bgWaitExitFromWire(w: WireBgWaitExitResponse): BgWaitExitResponse {
  const out: BgWaitExitResponse = {
    execId: w.exec_id,
    running: w.running,
    timedOut: w.timed_out,
  };
  if (w.exit_code !== undefined) out.exitCode = w.exit_code;
  if (w.signal !== undefined) out.signal = w.signal;
  if (w.ended_at !== undefined) out.endedAt = w.ended_at;
  return out;
}

function bgDeleteFromWire(w: WireBgDeleteResponse): BgDeleteResponse {
  return { execId: w.exec_id, reaped: w.reaped };
}
