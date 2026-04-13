/**
 * VM handle — returned from `client.vms.create()` / `client.vms.get()`.
 * Exposes per-VM operations (exec, fs, power, lifecycle).
 */

import { Readable } from 'node:stream';
import type { TransportClient } from './transport.js';
import {
  type AgentHealth,
  type ExecFrame,
  type ExecRequest,
  type ExecResult,
  type ExecResultBinary,
  type FSEntry,
  type FSMkdirRequest,
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

  private readonly transport: TransportClient;

  constructor(transport: TransportClient, init: VMInit) {
    this.transport = transport;
    this.hostname = init.hostname;
    this.hostGroup = init.hostGroup;
    if (init.ip !== undefined) this.ip = init.ip;
    if (init.createdAt !== undefined) this.createdAt = init.createdAt;
    if (init.arch !== undefined) this.arch = init.arch;
    this.fs = new VMFileSystem(transport, this.hostname);
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

  // --- exec -------------------------------------------------------------

  /**
   * Streaming exec — yields NDJSON frames (`started`, `stdout`, `stderr`, `exit`).
   * When `req.stdio === 'base64'`, each frame's `data`/`stdout`/`stderr` string
   * fields are preserved as-is (base64-encoded) and the SDK populates decoded
   * `dataBytes`/`stdoutBytes`/`stderrBytes` Buffers alongside for convenience.
   */
  async *exec(req: ExecRequest): AsyncGenerator<ExecFrame, void, void> {
    const { path, body } = buildExecPath(this.hostname, req, false);
    for await (const frame of this.transport.requestNDJSON<ExecFrame>('POST', path, body)) {
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
