/**
 * HTTP transport for the Slicer API. Supports two modes:
 *   - Unix socket:  absolute path (`/...`), `unix://...`, `./...`, `../...`, `~/...`, or any `*.sock`.
 *   - Network URL:  `http://host[:port]` or `https://host`.
 *
 * Mirrors the detection rules in the Go SDK's `normalizeUnixSocketPath`.
 */

import http, { IncomingMessage, RequestOptions } from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { URL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { SlicerAPIError } from './types.js';

export type Transport =
  | { kind: 'socket'; socketPath: string }
  | { kind: 'net'; url: URL };

export function resolveTransport(baseURL: string): Transport {
  const trimmed = baseURL.trim();
  if (!trimmed) throw new Error('Slicer baseURL is required');

  let candidate = trimmed;
  if (candidate.startsWith('unix://')) candidate = candidate.slice('unix://'.length);
  if (candidate.startsWith('~/')) candidate = path.join(os.homedir(), candidate.slice(2));

  const socketLike =
    candidate.startsWith('/') ||
    candidate.startsWith('./') ||
    candidate.startsWith('../') ||
    candidate.endsWith('.sock');
  if (socketLike) return { kind: 'socket', socketPath: candidate };

  return { kind: 'net', url: new URL(trimmed) };
}

export interface TransportClientOptions {
  baseURL: string;
  token?: string;
  userAgent?: string;
}

export class TransportClient {
  readonly transport: Transport;
  private readonly token?: string;
  private readonly userAgent: string;

  constructor(opts: TransportClientOptions) {
    this.transport = resolveTransport(opts.baseURL);
    this.token = opts.token;
    this.userAgent = opts.userAgent ?? 'slicer-sdk-ts/0.1.0';
  }

  private agent() {
    return this.transport.kind === 'net' && this.transport.url.protocol === 'https:'
      ? https
      : http;
  }

  private buildRequestOptions(
    method: string,
    reqPath: string,
    extraHeaders: Record<string, string> = {},
  ): RequestOptions {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      ...extraHeaders,
    };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    if (this.transport.kind === 'socket') {
      return {
        socketPath: this.transport.socketPath,
        method,
        path: reqPath,
        headers,
        setHost: true,
      };
    }
    const u = this.transport.url;
    return {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      method,
      path: reqPath,
      headers,
    };
  }

  /** Buffered JSON request. Rejects on non-2xx via SlicerAPIError. */
  request<T = unknown>(method: string, reqPath: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const headers: Record<string, string> = {};
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(payload.length);
      }
      const req = this.agent().request(
        this.buildRequestOptions(method, reqPath, headers),
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new SlicerAPIError(method, reqPath, status, raw));
              return;
            }
            if (!raw) {
              resolve(undefined as unknown as T);
              return;
            }
            try {
              resolve(JSON.parse(raw) as T);
            } catch {
              resolve(raw as unknown as T);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Raw-bytes request (for binary cp endpoints). */
  requestRaw(
    method: string,
    reqPath: string,
    body?: Buffer,
    contentType = 'application/octet-stream',
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (body) {
        headers['Content-Type'] = contentType;
        headers['Content-Length'] = String(body.length);
      }
      const req = this.agent().request(
        this.buildRequestOptions(method, reqPath, headers),
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const out = Buffer.concat(chunks);
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new SlicerAPIError(method, reqPath, status, out.toString('utf8')));
              return;
            }
            resolve(out);
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  /** Streaming request producing a Node Readable of the response body. */
  requestStreamRaw(
    method: string,
    reqPath: string,
    body?: Buffer | Readable,
    contentType = 'application/octet-stream',
  ): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (body instanceof Buffer) {
        headers['Content-Type'] = contentType;
        headers['Content-Length'] = String(body.length);
      } else if (body) {
        headers['Content-Type'] = contentType;
        headers['Transfer-Encoding'] = 'chunked';
      }
      const req = this.agent().request(
        this.buildRequestOptions(method, reqPath, headers),
        (res) => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () =>
              reject(
                new SlicerAPIError(method, reqPath, status, Buffer.concat(chunks).toString('utf8')),
              ),
            );
            return;
          }
          resolve(res);
        },
      );
      req.on('error', reject);
      if (body instanceof Buffer) {
        req.write(body);
        req.end();
      } else if (body) {
        (body as Readable).pipe(req);
      } else {
        req.end();
      }
    });
  }

  /** Yields decoded JSON frames from an NDJSON response (one JSON object per line). */
  async *requestNDJSON<Frame = unknown>(
    method: string,
    reqPath: string,
    body?: Buffer | Readable,
  ): AsyncGenerator<Frame, void, void> {
    const res = await this.requestStreamRaw(method, reqPath, body);
    res.setEncoding('utf8');
    let buffer = '';
    for await (const chunk of res as AsyncIterable<string>) {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as Frame;
        } catch {
          /* skip keep-alives / unparseable lines */
        }
      }
    }
    const trailing = buffer.trim();
    if (trailing) {
      try {
        yield JSON.parse(trailing) as Frame;
      } catch {
        /* ignore */
      }
    }
  }
}
