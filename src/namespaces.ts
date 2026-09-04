/**
 * Top-level namespaces on SlicerClient: hostGroups, vms, secrets.
 * Keep control-plane operations here; per-VM operations live on the VM handle.
 */

import type { TransportClient } from './transport.js';
import {
  type CreateSecretRequest,
  type CreateVMOptions,
  type CreateVMRequest,
  type CreateVMResponse,
  type CommitInfo,
  type ForkVMOptions,
  type ListCommitsOptions,
  type HostGroup,
  type ListOptions,
  type Secret,
  SecretExistsError,
  SlicerAPIError,
  type UpdateSecretRequest,
  type VMInfo,
  type VMStat,
} from './types.js';
import {
  createVMReqToWire,
  createVMResFromWire,
  hostGroupFromWire,
  secretFromWire,
  vmFromWire,
  vmStatFromWire,
  type WireCreateVMResponse,
  type WireHostGroup,
  type WireSecret,
  type WireVM,
  type WireVMStat,
} from './wire.js';
import { VM } from './vm.js';

export class HostGroupsAPI {
  constructor(private readonly transport: TransportClient) {}

  async list(): Promise<HostGroup[]> {
    const wire = await this.transport.request<WireHostGroup[]>('GET', '/hostgroup');
    return (wire ?? []).map(hostGroupFromWire);
  }

  /** Convenience lookup (no single-group endpoint exists on the daemon). */
  async find(name: string): Promise<HostGroup | undefined> {
    return (await this.list()).find((g) => g.name === name);
  }

  async listVMs(name: string, opts: ListOptions = {}): Promise<VMInfo[]> {
    const q = buildListQuery(opts);
    const wire = await this.transport.request<WireVM[]>(
      'GET',
      `/hostgroup/${encodeURIComponent(name)}/nodes${q}`,
    );
    return (wire ?? []).map(vmFromWire);
  }
}

export class VMsAPI {
  constructor(private readonly transport: TransportClient) {}

  async create(
    hostGroup: string,
    req: CreateVMRequest = {},
    opts: CreateVMOptions = {},
  ): Promise<VM> {
    const qs = new URLSearchParams();
    if (opts.wait) qs.set('wait', opts.wait);
    if (opts.waitTimeoutSec !== undefined) qs.set('timeout', `${opts.waitTimeoutSec}s`);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    const wire = await this.transport.request<WireCreateVMResponse>(
      'POST',
      `/hostgroup/${encodeURIComponent(hostGroup)}/nodes${query}`,
      createVMReqToWire(req),
    );
    const res = createVMResFromWire(wire);
    return new VM(this.transport, {
      hostname: res.hostname,
      hostGroup: res.hostGroup ?? hostGroup,
      ...(res.ip !== undefined && { ip: res.ip }),
      ...(res.createdAt !== undefined && { createdAt: res.createdAt }),
      ...(res.arch !== undefined && { arch: res.arch }),
    });
  }

  /**
   * Build a VM handle for an existing VM given its hostgroup + hostname. No
   * request is issued — use `health()` or `getInfo()` to verify reachability.
   */
  attach(hostGroup: string, hostname: string): VM {
    return new VM(this.transport, { hostname, hostGroup });
  }

  /** Look up a VM by hostname across all host groups. Returns `undefined` if not found. */
  async get(hostname: string): Promise<VM | undefined> {
    const all = await this.list();
    const found = all.find((v) => v.hostname === hostname);
    if (!found) return undefined;
    return new VM(this.transport, {
      hostname: found.hostname,
      hostGroup: found.hostGroup ?? '',
      ...(found.ip !== undefined && { ip: found.ip }),
      ...(found.createdAt !== undefined && { createdAt: found.createdAt }),
      ...(found.arch !== undefined && { arch: found.arch }),
    });
  }

  /** Return raw VM metadata across all host groups. */
  async list(opts: ListOptions = {}): Promise<VMInfo[]> {
    const q = buildListQuery(opts);
    const wire = await this.transport.request<WireVM[]>('GET', `/nodes${q}`);
    return (wire ?? []).map(vmFromWire);
  }

  async stats(): Promise<VMStat[]> {
    const raw = await this.transport.request<WireVMStat[]>('GET', '/nodes/stats');
    return (raw ?? []).map(vmStatFromWire);
  }

  /**
   * Raw response accessor — bypasses the VM handle. Useful when you only
   * want the create metadata without a handle.
   */
  async createRaw(
    hostGroup: string,
    req: CreateVMRequest = {},
    opts: CreateVMOptions = {},
  ): Promise<CreateVMResponse> {
    const qs = new URLSearchParams();
    if (opts.wait) qs.set('wait', opts.wait);
    if (opts.waitTimeoutSec !== undefined) qs.set('timeout', `${opts.waitTimeoutSec}s`);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    const wire = await this.transport.request<WireCreateVMResponse>(
      'POST',
      `/hostgroup/${encodeURIComponent(hostGroup)}/nodes${query}`,
      createVMReqToWire(req),
    );
    return createVMResFromWire(wire);
  }

  /**
   * Cold-fork a committed VM into a child that starts from the parent's
   * exact disk state. Get a `commitId` from `vm.commit()`. Returns a VM
   * handle for the child.
   */
  async fork(commitId: string, opts: ForkVMOptions = {}): Promise<VM> {
    const body: Record<string, unknown> = {};
    if (opts.tags) body.tags = opts.tags;
    if (opts.tagMode) body.tag_mode = opts.tagMode;
    if (opts.vcpu) body.vcpu = opts.vcpu;
    if (opts.ramBytes) body.ram_bytes = opts.ramBytes;
    if (opts.persistent !== undefined) body.persistent = opts.persistent;
    const w = await this.transport.request<{ hostname: string; ip?: string }>(
      'POST',
      `/vm/commits/${encodeURIComponent(commitId)}/fork`,
      body,
    );
    return new VM(this.transport, {
      hostname: w.hostname,
      hostGroup: opts.hostGroup ?? '',
      ...(w.ip !== undefined && { ip: w.ip }),
    });
  }

  /** List fork-parent commits on the daemon, optionally filtered. */
  async listCommits(opts: ListCommitsOptions = {}): Promise<CommitInfo[]> {
    const qs = new URLSearchParams();
    if (opts.cacheKey) qs.set('cache_key', opts.cacheKey);
    for (const t of opts.tags ?? []) qs.set('tag', t);
    const query = qs.toString() ? `?${qs.toString()}` : '';
    const wire = await this.transport.request<Array<Record<string, unknown>>>(
      'GET',
      `/vm/commits${query}`,
    );
    return (wire ?? []).map((c) => ({
      commitId: String(c.commit_id ?? ''),
      ...(c.cache_key !== undefined && { cacheKey: String(c.cache_key) }),
      ...(Array.isArray(c.tags) && { tags: c.tags as string[] }),
      ...c,
    }));
  }

  /** Delete a fork-parent commit. Fails while a child still references it. */
  async deleteCommit(commitId: string): Promise<void> {
    await this.transport.request('DELETE', `/vm/commits/${encodeURIComponent(commitId)}`);
  }
}

export class SecretsAPI {
  constructor(private readonly transport: TransportClient) {}

  async list(): Promise<Secret[]> {
    const wire = await this.transport.request<WireSecret[]>('GET', '/secrets');
    return (wire ?? []).map(secretFromWire);
  }

  async create(req: CreateSecretRequest): Promise<void> {
    const body = {
      name: req.name,
      data: Buffer.from(req.data).toString('base64'),
      ...(req.permissions !== undefined && { permissions: req.permissions }),
      ...(req.uid !== undefined && { uid: req.uid }),
      ...(req.gid !== undefined && { gid: req.gid }),
    };
    try {
      await this.transport.request('POST', '/secrets', body);
    } catch (err) {
      if (err instanceof SlicerAPIError && err.status === 409) {
        throw new SecretExistsError(req.name);
      }
      throw err;
    }
  }

  async patch(name: string, req: UpdateSecretRequest): Promise<void> {
    const body = {
      data: Buffer.from(req.data).toString('base64'),
      ...(req.permissions !== undefined && { permissions: req.permissions }),
      ...(req.uid !== undefined && { uid: req.uid }),
      ...(req.gid !== undefined && { gid: req.gid }),
    };
    await this.transport.request('PATCH', `/secrets/${encodeURIComponent(name)}`, body);
  }

  async delete(name: string): Promise<void> {
    await this.transport.request('DELETE', `/secrets/${encodeURIComponent(name)}`);
  }
}

function buildListQuery(opts: ListOptions): string {
  const qs = new URLSearchParams();
  if (opts.tag) qs.set('tag', opts.tag);
  if (opts.tagPrefix) qs.set('tag_prefix', opts.tagPrefix);
  const s = qs.toString();
  return s ? `?${s}` : '';
}
