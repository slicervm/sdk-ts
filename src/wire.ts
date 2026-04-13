/**
 * Wire-format converters. The only place camelCase ↔ snake_case bridging
 * should live. All outbound request bodies and inbound response bodies are
 * shaped exactly as the daemon emits; model types above are idiomatic TS.
 */

import type {
  AgentHealth,
  CreateVMRequest,
  CreateVMResponse,
  FSEntry,
  HostGroup,
  Secret,
  VMInfo,
  VMStat,
} from './types.js';

export interface WireHostGroup {
  name?: string;
  count?: number;
  ram_bytes?: number;
  cpus?: number;
  arch?: string;
  gpu_count?: number;
}

export interface WireVM {
  hostname: string;
  hostgroup?: string;
  ip: string;
  ram_bytes?: number;
  cpus?: number;
  created_at: string;
  arch?: string;
  tags?: string[];
  status?: string;
  persistent?: boolean;
}

export interface WireCreateVMRequest {
  ram_bytes?: number;
  cpus?: number;
  gpu_count?: number;
  persistent?: boolean;
  disk_image?: string;
  import_user?: string;
  ssh_keys?: string[];
  userdata?: string;
  ip?: string;
  tags?: string[];
  secrets?: string[];
}

export interface WireCreateVMResponse {
  hostname: string;
  hostgroup?: string;
  ip: string;
  created_at: string;
  arch?: string;
}

export interface WireAgentHealth {
  hostname?: string;
  agent_uptime?: number;
  agent_version?: string;
  system_uptime?: number;
  userdata_ran?: boolean;
}

export interface WireFSInfo {
  name: string;
  type: string;
  size: number;
  mtime: string;
  mode: string;
}

export interface WireVMStat {
  hostname: string;
  ip: string;
  created_at: string;
  snapshot?: unknown;
  error?: string;
}

export interface WireSecret {
  name: string;
  size: number;
  permissions: string;
  uid?: number;
  gid?: number;
  modified_at?: string;
}

export function hostGroupFromWire(w: WireHostGroup): HostGroup {
  return {
    name: w.name ?? '',
    count: w.count ?? 0,
    ramBytes: w.ram_bytes ?? 0,
    cpus: w.cpus ?? 0,
    arch: w.arch ?? '',
    ...(w.gpu_count !== undefined && { gpuCount: w.gpu_count }),
  };
}

export function vmFromWire(w: WireVM): VMInfo {
  return {
    hostname: w.hostname,
    ip: w.ip,
    createdAt: w.created_at,
    ...(w.hostgroup !== undefined && { hostGroup: w.hostgroup }),
    ...(w.ram_bytes !== undefined && { ramBytes: w.ram_bytes }),
    ...(w.cpus !== undefined && { cpus: w.cpus }),
    ...(w.arch !== undefined && { arch: w.arch }),
    ...(w.tags !== undefined && { tags: w.tags }),
    ...(w.status !== undefined && { status: w.status }),
    ...(w.persistent !== undefined && { persistent: w.persistent }),
  };
}

export function createVMReqToWire(r: CreateVMRequest): WireCreateVMRequest {
  const o: WireCreateVMRequest = {};
  if (r.ramBytes !== undefined) o.ram_bytes = r.ramBytes;
  if (r.cpus !== undefined) o.cpus = r.cpus;
  if (r.gpuCount !== undefined) o.gpu_count = r.gpuCount;
  if (r.persistent !== undefined) o.persistent = r.persistent;
  if (r.diskImage !== undefined) o.disk_image = r.diskImage;
  if (r.importUser !== undefined) o.import_user = r.importUser;
  if (r.sshKeys !== undefined) o.ssh_keys = r.sshKeys;
  if (r.userdata !== undefined) o.userdata = r.userdata;
  if (r.ip !== undefined) o.ip = r.ip;
  if (r.tags !== undefined) o.tags = r.tags;
  if (r.secrets !== undefined) o.secrets = r.secrets;
  return o;
}

export function createVMResFromWire(w: WireCreateVMResponse): CreateVMResponse {
  return {
    hostname: w.hostname,
    ip: w.ip,
    createdAt: w.created_at,
    ...(w.hostgroup !== undefined && { hostGroup: w.hostgroup }),
    ...(w.arch !== undefined && { arch: w.arch }),
  };
}

export function agentHealthFromWire(w: WireAgentHealth): AgentHealth {
  return {
    ...(w.hostname !== undefined && { hostname: w.hostname }),
    ...(w.agent_uptime !== undefined && { agentUptime: w.agent_uptime }),
    ...(w.agent_version !== undefined && { agentVersion: w.agent_version }),
    ...(w.system_uptime !== undefined && { systemUptime: w.system_uptime }),
    ...(w.userdata_ran !== undefined && { userdataRan: w.userdata_ran }),
  };
}

export function fsEntryFromWire(w: WireFSInfo): FSEntry {
  return { name: w.name, type: w.type, size: w.size, mtime: w.mtime, mode: w.mode };
}

export function vmStatFromWire(w: WireVMStat): VMStat {
  return {
    hostname: w.hostname,
    ip: w.ip,
    createdAt: w.created_at,
    ...(w.snapshot !== undefined && { snapshot: w.snapshot as VMStat['snapshot'] }),
    ...(w.error !== undefined && { error: w.error }),
  };
}

export function secretFromWire(w: WireSecret): Secret {
  return {
    name: w.name,
    size: w.size,
    permissions: w.permissions,
    ...(w.uid !== undefined && { uid: w.uid }),
    ...(w.gid !== undefined && { gid: w.gid }),
    ...(w.modified_at !== undefined && { modifiedAt: w.modified_at }),
  };
}
