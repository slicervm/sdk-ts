import { describe, expect, it } from 'vitest';
import { createVMReqToWire } from '../src/wire.js';

describe('createVMReqToWire', () => {
  it('passes isolated network launch overrides through to wire JSON', () => {
    expect(
      createVMReqToWire({
        cpus: 1,
        network: {
          allow: ['192.168.222.1:18081'],
          drop: ['0.0.0.0/0'],
        },
      }),
    ).toEqual({
      cpus: 1,
      network: {
        allow: ['192.168.222.1:18081'],
        drop: ['0.0.0.0/0'],
      },
    });
  });

  it('preserves empty network override lists', () => {
    expect(
      createVMReqToWire({
        network: {
          allow: [],
        },
      }),
    ).toEqual({
      network: {
        allow: [],
      },
    });
  });
});
