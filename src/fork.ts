import type { VMForkOptions } from './types.js';

export function buildForkRequest(opts: VMForkOptions): {
  query: string;
  body?: Record<string, unknown>;
} {
  const wait = opts.wait ?? 'agent';
  if (wait !== 'agent' && wait !== 'none') {
    throw new Error(`invalid fork wait mode ${JSON.stringify(wait)}`);
  }

  const query = new URLSearchParams({ wait });
  if (opts.waitTimeoutSec !== undefined && opts.waitTimeoutSec > 0) {
    query.set('timeout', `${opts.waitTimeoutSec}s`);
  }

  const body: Record<string, unknown> = {};
  if (opts.network !== undefined) body.network = opts.network;
  if (opts.tags !== undefined) body.tags = opts.tags;
  if (opts.tagMode !== undefined) body.tag_mode = opts.tagMode;
  if (opts.secrets !== undefined) body.secrets = opts.secrets;
  if (opts.persistent !== undefined) body.persistent = opts.persistent;
  if (opts.fixups !== undefined) body.fixups = opts.fixups;
  if (opts.vcpu !== undefined) body.vcpu = opts.vcpu;
  if (opts.ramBytes !== undefined) body.ram_bytes = opts.ramBytes;

  return {
    query: query.toString(),
    ...(Object.keys(body).length > 0 && { body }),
  };
}
