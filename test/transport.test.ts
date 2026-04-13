import { describe, expect, it } from 'vitest';
import { resolveTransport } from '../src/transport.js';

describe('resolveTransport', () => {
  it('recognizes absolute socket paths', () => {
    const t = resolveTransport('/Users/me/slicer-mac/slicer.sock');
    expect(t.kind).toBe('socket');
    if (t.kind === 'socket') expect(t.socketPath).toBe('/Users/me/slicer-mac/slicer.sock');
  });

  it('recognizes unix:// prefixed sockets', () => {
    const t = resolveTransport('unix:///tmp/slicer.sock');
    expect(t.kind).toBe('socket');
    if (t.kind === 'socket') expect(t.socketPath).toBe('/tmp/slicer.sock');
  });

  it('recognizes .sock suffix even without slash', () => {
    const t = resolveTransport('slicer.sock');
    expect(t.kind).toBe('socket');
  });

  it('expands ~/ home prefix', () => {
    const t = resolveTransport('~/slicer.sock');
    expect(t.kind).toBe('socket');
    if (t.kind === 'socket') expect(t.socketPath).toMatch(/\/slicer\.sock$/);
  });

  it('treats http(s) URLs as net transport', () => {
    const t = resolveTransport('http://127.0.0.1:8080');
    expect(t.kind).toBe('net');
    if (t.kind === 'net') expect(t.url.hostname).toBe('127.0.0.1');
  });

  it('rejects empty baseURL', () => {
    expect(() => resolveTransport('')).toThrow();
  });
});
