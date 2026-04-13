/**
 * Port forwarding for Slicer VMs.
 *
 * Per-connection WebSocket model: each accepted local TCP/Unix connection
 * opens a fresh WebSocket to /vm/{hostname}/forward on the daemon. The
 * WebSocket carries raw bytes both directions (binary frames, no framing
 * subprotocol). The daemon uses the `X-Inlets-Upstream` header on the
 * upgrade request to decide where to dial inside the VM.
 */

import net, { createServer as createNetServer, type Server as TcpServer, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http, { type Agent as HttpAgent } from 'node:http';
import { WebSocket, type ClientOptions as WSClientOptions, createWebSocketStream } from 'ws';
import type { Transport } from './transport.js';

// --- address-mapping parser ----------------------------------------------

export interface AddressMapping {
  rawSpec: string;
  /** TCP listen address, or undefined when listening on a Unix socket. */
  listenAddr?: string;
  /** TCP listen port, or undefined when listening on a Unix socket. */
  listenPort?: number;
  /** Listen Unix socket path, or undefined when listening on TCP. */
  listenUnixPath?: string;
  /** Remote host inside the VM, or undefined when targeting a Unix socket. */
  remoteHost?: string;
  /** Remote port inside the VM, or undefined when targeting a Unix socket. */
  remotePort?: number;
  /** Remote Unix socket path inside the VM, or undefined when targeting TCP. */
  remoteUnixPath?: string;
}

function looksLikeUnixSocketPath(s: string): boolean {
  if (!s) return false;
  return s.startsWith('/') || s.startsWith('./') || s.startsWith('../') || s.includes('/');
}

/**
 * Parse a `-L`-style spec into an {@link AddressMapping}. Supported formats
 * mirror the Go SDK's `slicer vm forward` CLI:
 *
 * - `127.0.0.1:9000` — listen and forward on the same TCP host:port
 * - `9001:127.0.0.1:9000` — listen on `0.0.0.0:9001`, forward to `127.0.0.1:9000`
 * - `0:127.0.0.1:9000` — listen on a random TCP port, forward as above
 * - `0.0.0.0:9000:127.0.0.1:9000` — listen and forward, fully explicit
 * - `127.0.0.1:9000:/var/run/docker.sock` — TCP listen, Unix socket forward
 * - `9000:/var/run/docker.sock` — `0.0.0.0:9000` listen, Unix socket forward
 * - `/tmp/docker.sock:/var/run/docker.sock` — Unix-to-Unix forward
 * - `./docker.sock:/var/run/docker.sock` — Unix-to-Unix with relative local
 */
export function parseAddressMapping(spec: string): AddressMapping {
  // Unix-to-Unix: both sides look like paths.
  const lastColon = spec.lastIndexOf(':');
  if (lastColon !== -1) {
    const localPart = spec.slice(0, lastColon);
    const remotePart = spec.slice(lastColon + 1);
    if (looksLikeUnixSocketPath(localPart) && looksLikeUnixSocketPath(remotePart)) {
      const localAbs = path.isAbsolute(localPart) ? localPart : path.resolve(localPart);
      return { rawSpec: spec, listenUnixPath: localAbs, remoteUnixPath: remotePart };
    }
  }

  // TCP-to-Unix: the substring `:/` marks the boundary.
  const tcpToUnix = spec.indexOf(':/');
  if (tcpToUnix !== -1) {
    const listenPart = spec.slice(0, tcpToUnix);
    const socketPath = spec.slice(tcpToUnix + 1); // keep leading slash
    const innerColon = listenPart.lastIndexOf(':');
    if (innerColon === -1) {
      return {
        rawSpec: spec,
        listenAddr: '0.0.0.0',
        listenPort: parsePort(listenPart, spec),
        remoteUnixPath: socketPath,
      };
    }
    return {
      rawSpec: spec,
      listenAddr: listenPart.slice(0, innerColon),
      listenPort: parsePort(listenPart.slice(innerColon + 1), spec),
      remoteUnixPath: socketPath,
    };
  }

  const parts = spec.split(':');
  switch (parts.length) {
    case 2:
      return {
        rawSpec: spec,
        listenAddr: parts[0]!,
        listenPort: parsePort(parts[1]!, spec),
        remoteHost: parts[0]!,
        remotePort: parsePort(parts[1]!, spec),
      };
    case 3:
      return {
        rawSpec: spec,
        listenAddr: parts[1]!,
        listenPort: parsePort(parts[0]!, spec),
        remoteHost: parts[1]!,
        remotePort: parsePort(parts[2]!, spec),
      };
    case 4:
      return {
        rawSpec: spec,
        listenAddr: parts[0]!,
        listenPort: parsePort(parts[1]!, spec),
        remoteHost: parts[2]!,
        remotePort: parsePort(parts[3]!, spec),
      };
    default:
      throw new Error(`invalid forward spec ${JSON.stringify(spec)}: expected 2-4 colon-separated parts`);
  }
}

function parsePort(s: string, spec: string): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`invalid port ${JSON.stringify(s)} in forward spec ${JSON.stringify(spec)}`);
  }
  return n;
}

function isListenUnix(m: AddressMapping): boolean {
  return m.listenUnixPath !== undefined;
}

function remoteTargetHeader(m: AddressMapping): string {
  if (m.remoteUnixPath) return `unix:${m.remoteUnixPath}`;
  return `${m.remoteHost}:${m.remotePort}`;
}

function listenAddressDescription(m: AddressMapping): string {
  if (isListenUnix(m)) return m.listenUnixPath!;
  return `${m.listenAddr}:${m.listenPort}`;
}

// --- forwarder ------------------------------------------------------------

export interface ForwarderListener {
  /** The original spec string that produced this listener. */
  spec: string;
  /** Human-readable local address (`127.0.0.1:8080`, `/tmp/docker.sock`, etc). */
  local: string;
  /** Human-readable upstream target inside the VM. */
  remote: string;
  /** Resolved port for TCP listeners (useful when caller asked for `0`). */
  port?: number;
}

export interface ForwarderOptions {
  /** Identifies this client to the daemon. Defaults to `os.hostname()`. */
  clientId?: string;
  /** WebSocket dial timeout (ms). Default 10_000. */
  dialTimeoutMs?: number;
  /**
   * Optional logger for connection events. Receives short strings. Default: silent.
   */
  log?: (msg: string) => void;
}

export interface ForwarderInit {
  hostname: string;
  transport: Transport;
  token?: string;
  userAgent: string;
  specs: string[];
  options?: ForwarderOptions;
}

/**
 * A live set of port forwards for one VM. Returned by `vm.forward(...)`.
 * Closing the forwarder tears down all local listeners and any in-flight
 * tunnel WebSockets.
 */
export class Forwarder {
  readonly listeners: ForwarderListener[] = [];
  private readonly servers: TcpServer[] = [];
  private readonly liveSockets = new Set<{ close: () => void }>();
  private closed = false;

  private constructor(
    private readonly init: ForwarderInit,
    private readonly mappings: AddressMapping[],
  ) {}

  static async start(init: ForwarderInit): Promise<Forwarder> {
    if (init.specs.length === 0) {
      throw new Error('Forwarder requires at least one forward spec');
    }
    const mappings = init.specs.map(parseAddressMapping);
    const fwd = new Forwarder(init, mappings);
    try {
      await fwd.bindAll();
    } catch (err) {
      await fwd.close();
      throw err;
    }
    return fwd;
  }

  private async bindAll(): Promise<void> {
    for (const m of this.mappings) {
      const server = createNetServer((socket) => this.handleAccept(m, socket));
      const { local, port } = await listen(server, m);
      this.servers.push(server);
      this.listeners.push({
        spec: m.rawSpec,
        local,
        remote: remoteTargetHeader(m),
        ...(port !== undefined && { port }),
      });
      this.log(`listen ${local} → ${remoteTargetHeader(m)}`);
    }
  }

  private handleAccept(mapping: AddressMapping, socket: Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    socket.on('error', () => {
      /* connection-level errors are surfaced via close */
    });

    const ws = openWebSocket(this.init, mapping);
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      try { socket.destroy(); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
      this.liveSockets.delete(handle);
    };
    const handle = { close: cleanup };
    this.liveSockets.add(handle);

    ws.binaryType = 'nodebuffer';
    ws.on('open', () => {
      const wsStream = createWebSocketStream(ws);
      wsStream.on('error', cleanup);
      socket.pipe(wsStream);
      wsStream.pipe(socket);
    });
    ws.on('close', cleanup);
    ws.on('error', (err) => {
      this.log(`tunnel error: ${err.message}`);
      cleanup();
    });
    socket.on('close', cleanup);
  }

  /** Tear down all listeners and any in-flight tunnel sockets. */
  async close(): Promise<void> {
    this.closed = true;
    for (const handle of [...this.liveSockets]) handle.close();
    this.liveSockets.clear();

    await Promise.all(
      this.servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
          }),
      ),
    );

    // Clean up Unix socket files we created.
    for (const m of this.mappings) {
      if (isListenUnix(m) && m.listenUnixPath) {
        try {
          fs.rmSync(m.listenUnixPath, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  private log(msg: string): void {
    this.init.options?.log?.(msg);
  }
}

// --- helpers --------------------------------------------------------------

function listen(
  server: TcpServer,
  mapping: AddressMapping,
): Promise<{ local: string; port?: number }> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    if (isListenUnix(mapping)) {
      const p = mapping.listenUnixPath!;
      // Remove any stale socket file first.
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
      server.listen(p, () => {
        try {
          fs.chmodSync(p, 0o660);
        } catch {
          /* best-effort */
        }
        resolve({ local: p });
      });
      return;
    }

    server.listen({ host: mapping.listenAddr, port: mapping.listenPort }, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const local = `${mapping.listenAddr}:${addr.port}`;
        resolve({ local, port: addr.port });
      } else {
        resolve({ local: listenAddressDescription(mapping) });
      }
    });
  });
}

function openWebSocket(init: ForwarderInit, mapping: AddressMapping): WebSocket {
  const url = wsURLForVM(init.transport, init.hostname);
  const headers: Record<string, string> = {
    'X-Inlets-Client-ID': init.options?.clientId ?? os.hostname(),
    'X-Inlets-Mode': 'local',
    'X-Inlets-Upstream': remoteTargetHeader(mapping),
    'User-Agent': init.userAgent,
  };
  if (init.token) headers['Authorization'] = `Bearer ${init.token}`;

  const opts: WSClientOptions = {
    headers,
    handshakeTimeout: init.options?.dialTimeoutMs ?? 10_000,
  };
  if (init.transport.kind === 'socket') {
    opts.agent = unixAgent(init.transport.socketPath);
  }
  return new WebSocket(url, opts);
}

function wsURLForVM(transport: Transport, hostname: string): string {
  if (transport.kind === 'socket') {
    // Host part is irrelevant; the unix-socket agent overrides the dial.
    return `ws://localhost/vm/${encodeURIComponent(hostname)}/forward`;
  }
  const u = transport.url;
  const scheme = u.protocol === 'https:' ? 'wss' : 'ws';
  const port = u.port ? `:${u.port}` : '';
  return `${scheme}://${u.hostname}${port}/vm/${encodeURIComponent(hostname)}/forward`;
}

function unixAgent(socketPath: string): HttpAgent {
  const agent = new http.Agent({ keepAlive: false });
  // ws's HTTP upgrade goes through `agent.createConnection`. Override it to
  // dial the daemon's unix socket instead of opening a TCP connection.
  (agent as unknown as { createConnection: typeof agent.createConnection }).createConnection = ((
    _opts: unknown,
    cb?: (err: Error | null, sock?: net.Socket) => void,
  ) => {
    const conn = net.createConnection({ path: socketPath });
    if (cb) {
      conn.once('connect', () => cb(null, conn));
      conn.once('error', (err: Error) => cb(err));
    }
    return conn;
  }) as typeof agent.createConnection;
  return agent;
}
