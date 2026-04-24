/**
 * Browser-compatible shell adapter for Slicer VMs.
 *
 * Provides frame encode/decode helpers and a `SlicerShellSession` class that
 * wires a standard browser WebSocket to an xterm.js Terminal instance using
 * the Slicer binary shell protocol.
 *
 * This module intentionally avoids Node-only imports so it can be used in
 * browser bundles.
 */

// --- frame type constants ----------------------------------------------------

export const FRAME_TYPE_DATA = 0x01;
export const FRAME_TYPE_WINDOW_SIZE = 0x02;
export const FRAME_TYPE_SHUTDOWN = 0x03;
export const FRAME_TYPE_HEARTBEAT = 0x04;
export const FRAME_TYPE_SESSION_CLOSE = 0x05;

// --- frame helpers -----------------------------------------------------------

const HEADER_SIZE = 5;

/** Encode a frame into the 5-byte-header binary protocol. */
export function encodeFrame(frameType: number, payload?: Uint8Array): Uint8Array {
  const payloadLen = payload ? payload.byteLength : 0;
  const buf = new Uint8Array(HEADER_SIZE + payloadLen);
  const view = new DataView(buf.buffer);
  view.setUint8(0, frameType);
  view.setUint32(1, payloadLen, false); // big-endian
  if (payload) buf.set(payload, HEADER_SIZE);
  return buf;
}

/** Parse a binary frame. Returns null if the data is malformed. */
export function parseFrame(data: ArrayBuffer): { frameType: number; payload: Uint8Array } | null {
  if (data.byteLength < HEADER_SIZE) return null;
  const view = new DataView(data);
  const frameType = view.getUint8(0);
  const payloadLen = view.getUint32(1, false); // big-endian
  if (data.byteLength < HEADER_SIZE + payloadLen) return null;
  const payload = new Uint8Array(data, HEADER_SIZE, payloadLen);
  return { frameType, payload };
}

// --- types -------------------------------------------------------------------

export interface ShellSessionOptions {
  /** WebSocket URL for the shell endpoint (ws:// or wss://). */
  url: string;
  /** Heartbeat interval in ms. Default 30000. */
  heartbeatIntervalMs?: number;
  /** Called when connection state changes. */
  onStateChange?: (state: 'connecting' | 'connected' | 'disconnected') => void;
  /** Called on error. */
  onError?: (error: string) => void;
}

/**
 * Minimal xterm.js Terminal interface — only the methods SlicerShellSession
 * actually calls. Avoids requiring @xterm/xterm as a dependency.
 */
export interface XTermLike {
  onData: (cb: (data: string) => void) => { dispose: () => void };
  write: (data: string) => void;
  reset: () => void;
  cols: number;
  rows: number;
}

// --- minimal browser type stubs ----------------------------------------------
// The SDK targets Node (lib: ES2022, no DOM). Declare the subset of browser
// APIs the class actually uses so this file compiles without adding "DOM" to
// the project-wide tsconfig.

interface BrowserWebSocket {
  binaryType: string;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: ArrayBufferLike | Uint8Array | string): void;
  close(code?: number, reason?: string): void;
}

interface BrowserWebSocketConstructor {
  new (url: string): BrowserWebSocket;
  readonly OPEN: number;
}

declare const WebSocket: BrowserWebSocketConstructor;

// --- class -------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SlicerShellSession {
  private ws: BrowserWebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private dataDisposable: { dispose: () => void } | null = null;

  constructor(
    private readonly terminal: XTermLike,
    private readonly options: ShellSessionOptions,
  ) {}

  /** True when the WebSocket is open and relaying. */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Open the WebSocket and begin relaying. */
  connect(): void {
    if (this.ws) return;
    this.options.onStateChange?.('connecting');

    const ws = new WebSocket(this.options.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.options.onStateChange?.('connected');
      this.terminal.reset();
      this.sendResize(this.terminal.cols, this.terminal.rows);
      this.startHeartbeat();
    };

    ws.onmessage = (ev: { data: unknown }) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      const frame = parseFrame(ev.data);
      if (!frame) return;

      switch (frame.frameType) {
        case FRAME_TYPE_DATA:
          this.terminal.write(decoder.decode(frame.payload));
          break;
        case FRAME_TYPE_SHUTDOWN:
        case FRAME_TYPE_SESSION_CLOSE:
          this.teardown();
          break;
      }
    };

    ws.onclose = () => {
      this.teardown();
    };

    ws.onerror = () => {
      this.options.onError?.('WebSocket error');
      this.teardown();
    };

    this.dataDisposable = this.terminal.onData((data: string) => {
      if (!this.connected) return;
      const payload = encoder.encode(data);
      this.ws!.send(encodeFrame(FRAME_TYPE_DATA, payload));
    });
  }

  /** Send a graceful shutdown frame and close. */
  disconnect(): void {
    if (this.ws) {
      try {
        this.ws.send(encodeFrame(FRAME_TYPE_SHUTDOWN));
      } catch {
        /* ws may already be closed */
      }
    }
    this.teardown();
  }

  /** Send a window resize. Call this from FitAddon's onResize or a ResizeObserver. */
  resize(cols: number, rows: number): void {
    if (!this.connected) return;
    this.sendResize(cols, rows);
  }

  // --- internals -------------------------------------------------------------

  private sendResize(cols: number, rows: number): void {
    const payload = new Uint8Array(8);
    const view = new DataView(payload.buffer);
    view.setUint32(0, cols, false); // big-endian
    view.setUint32(4, rows, false);
    this.ws!.send(encodeFrame(FRAME_TYPE_WINDOW_SIZE, payload));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const intervalMs = this.options.heartbeatIntervalMs ?? 30_000;
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) return;
      this.ws!.send(encodeFrame(FRAME_TYPE_HEARTBEAT));
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private teardown(): void {
    this.stopHeartbeat();
    if (this.dataDisposable) {
      this.dataDisposable.dispose();
      this.dataDisposable = null;
    }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.options.onStateChange?.('disconnected');
  }
}
