/**
 * Slicer API types. Wire shapes mirror the Go SDK at github.com/slicervm/sdk
 * (which calls these "Node" / "SlicerNode"); the TS SDK renames to "VM" for
 * clarity, since Slicer's primary primitive is a VM.
 */

export interface HostGroup {
  name: string;
  count: number;
  ramBytes: number;
  cpus: number;
  arch: string;
  gpuCount?: number;
}

export interface VMInfo {
  hostname: string;
  hostGroup?: string;
  ip: string;
  ramBytes?: number;
  cpus?: number;
  createdAt: string;
  arch?: string;
  tags?: string[];
  status?: string;
  persistent?: boolean;
}

export interface CreateVMRequest {
  ramBytes?: number;
  cpus?: number;
  gpuCount?: number;
  persistent?: boolean;
  diskImage?: string;
  importUser?: string;
  sshKeys?: string[];
  userdata?: string;
  ip?: string;
  tags?: string[];
  secrets?: string[];
}

export interface CreateVMResponse {
  hostname: string;
  hostGroup?: string;
  ip: string;
  createdAt: string;
  arch?: string;
}

export interface AgentHealth {
  hostname?: string;
  agentUptime?: number;
  agentVersion?: string;
  systemUptime?: number;
  userdataRan?: boolean;
}

export interface VMLogs {
  hostname: string;
  lines: number;
  content: string;
}

export interface DeleteResponse {
  message?: string;
  diskRemoved?: string;
  error?: string;
}

/** Wire encoding of exec stdout/stderr. Defaults to `"text"`. */
export type ExecStdio = 'text' | 'base64';
export const ExecStdioText: ExecStdio = 'text';
export const ExecStdioBase64: ExecStdio = 'base64';

export interface ExecRequest {
  command?: string;
  args?: string[];
  env?: string[];
  uid?: number;
  gid?: number;
  stdin?: Buffer | string;
  shell?: string;
  cwd?: string;
  permissions?: string;
  /**
   * Wire encoding for stdout/stderr.
   *  - `"text"` (default): frames carry UTF-8 strings. Safe for text output only —
   *     arbitrary binary will be mangled by JSON string escaping.
   *  - `"base64"`: frames carry base64-encoded bytes. Required for binary output
   *     (video, compressed archives, raw protocol streams). The SDK decodes
   *     automatically — callers get `Buffer` on `execBuffered({ stdio: 'base64' })`
   *     and `{stdoutBytes, stderrBytes, dataBytes}` on streamed frames.
   */
  stdio?: ExecStdio;
}

export interface ExecFrame {
  timestamp?: string;
  type?: string;
  pid?: number;
  encoding?: ExecStdio;
  /** Raw wire value — string under text mode, base64 string under base64 mode. */
  data?: string;
  startedAt?: string;
  endedAt?: string;
  signal?: string;
  stdout?: string;
  stderr?: string;
  /** Decoded bytes when `encoding === 'base64'`. SDK-populated convenience field. */
  dataBytes?: Buffer;
  stdoutBytes?: Buffer;
  stderrBytes?: Buffer;
  exitCode?: number;
  error?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  encoding?: ExecStdio;
  pid?: number;
  startedAt?: string;
  endedAt?: string;
  signal?: string;
  exitCode: number;
  error?: string;
}

/** Returned by `execBuffered` when `stdio === 'base64'`. stdout/stderr are decoded Buffers. */
export interface ExecResultBinary {
  stdout: Buffer;
  stderr: Buffer;
  encoding: 'base64';
  pid?: number;
  startedAt?: string;
  endedAt?: string;
  signal?: string;
  exitCode: number;
  error?: string;
}

export interface FSEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | string;
  size: number;
  mtime: string;
  mode: string;
}

export interface FSMkdirRequest {
  path: string;
  recursive?: boolean;
  mode?: string;
}

export interface ShutdownRequest {
  action?: 'shutdown' | 'reboot';
}

export interface VMStat {
  hostname: string;
  ip: string;
  createdAt: string;
  snapshot?: VMSnapshot | null;
  error?: string;
}

export interface VMSnapshot {
  hostname: string;
  arch: string;
  timestamp: string;
  uptime: string;
  totalCpus: number;
  totalMemory: number;
  memoryUsed: number;
  memoryAvailable: number;
  memoryUsedPercent: number;
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  diskReadTotal: number;
  diskWriteTotal: number;
  networkReadTotal: number;
  networkWriteTotal: number;
  diskIOInflight: number;
  openConnections: number;
  openFiles: number;
  entropy: number;
  diskSpaceTotal: number;
  diskSpaceUsed: number;
  diskSpaceFree: number;
  diskSpaceUsedPercent: number;
}

export interface SlicerInfo {
  version?: string;
  gitCommit?: string;
  platform?: string;
  arch?: string;
}

export interface ListOptions {
  tag?: string;
  tagPrefix?: string;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export interface CreateVMOptions {
  /**
   * Server-side wait: `"agent"` waits for the in-guest agent to be ready,
   * `"userdata"` additionally waits for userdata to run. If unset the daemon
   * returns immediately once the VM is scheduled.
   */
  wait?: 'agent' | 'userdata';
  /** Server-side wait timeout, in seconds. Forwarded as a Go duration. */
  waitTimeoutSec?: number;
}

export interface Secret {
  name: string;
  size: number;
  permissions: string;
  uid?: number;
  gid?: number;
  modifiedAt?: string;
}

export interface CreateSecretRequest {
  name: string;
  data: string;
  permissions?: string;
  uid?: number;
  gid?: number;
}

export interface UpdateSecretRequest {
  data: string;
  permissions?: string;
  uid?: number;
  gid?: number;
}

export class SecretExistsError extends Error {
  constructor(name: string) {
    super(`secret already exists: ${name}`);
    this.name = 'SecretExistsError';
  }
}

export class SlicerAPIError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  constructor(method: string, path: string, status: number, body: string) {
    super(`slicer ${method} ${path} failed: ${status} ${body}`);
    this.name = 'SlicerAPIError';
    this.method = method;
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

export const MiB = (n: number): number => n * 1024 * 1024;
export const GiB = (n: number): number => n * 1024 * 1024 * 1024;
export const NonRootUser = 0xffffffff;
