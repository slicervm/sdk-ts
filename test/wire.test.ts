import { describe, expect, it } from 'vitest';
import { agentHealthFromWire, createVMReqToWire } from '../src/wire.js';

describe('createVMReqToWire', () => {
  it('omits network to preserve the creation default', () => {
    expect(JSON.parse(JSON.stringify(createVMReqToWire({})))).not.toHaveProperty('network');
  });

  it('serializes an explicit offline attachment', () => {
    const network = { mode: 'none' } as const;
    expect(JSON.parse(JSON.stringify(createVMReqToWire({ network })))).toEqual({ network });
  });

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

describe('agentHealthFromWire', () => {
  it('maps the userdata exit code', () => {
    expect(
      agentHealthFromWire({
        userdata_ran: true,
        userdata_exit_code: 17,
      }),
    ).toEqual({
      userdataRan: true,
      userdataExitCode: 17,
    });
  });
});
