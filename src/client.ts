/**
 * SlicerClient — grouped TypeScript client for the Slicer VM API.
 *
 * Shape:
 *   client.hostGroups.list() / find(name) / listVMs(name)
 *   client.vms.create(group, req, opts) → VM / get(name) / list() / stats() / attach(group, name)
 *   client.secrets.list / create / patch / delete
 *   client.getInfo()
 *
 * Per-VM operations live on the `VM` handle returned from `client.vms.create`
 * or `client.vms.attach`: `vm.exec`, `vm.execBuffered`, `vm.fs.*`,
 * `vm.pause/resume/suspend/restore/shutdown/relaunch`, `vm.health/logs`,
 * `vm.waitForAgent/waitForUserdata`, `vm.delete`.
 */

import { TransportClient, type TransportClientOptions } from './transport.js';
import { HostGroupsAPI, SecretsAPI, VMsAPI } from './namespaces.js';
import type { SlicerInfo } from './types.js';

export interface SlicerClientOptions extends TransportClientOptions {}

export class SlicerClient {
  readonly transport: TransportClient;
  readonly hostGroups: HostGroupsAPI;
  readonly vms: VMsAPI;
  readonly secrets: SecretsAPI;

  constructor(opts: SlicerClientOptions) {
    this.transport = new TransportClient(opts);
    this.hostGroups = new HostGroupsAPI(this.transport);
    this.vms = new VMsAPI(this.transport);
    this.secrets = new SecretsAPI(this.transport);
  }

  static fromEnv(overrides: Partial<SlicerClientOptions> = {}): SlicerClient {
    const baseURL = overrides.baseURL ?? process.env.SLICER_URL;
    if (!baseURL) throw new Error('SLICER_URL is required (or pass baseURL)');
    const token = overrides.token ?? process.env.SLICER_TOKEN ?? undefined;
    return new SlicerClient({
      baseURL,
      ...(token !== undefined && { token }),
      ...(overrides.userAgent !== undefined && { userAgent: overrides.userAgent }),
    });
  }

  async getInfo(): Promise<SlicerInfo> {
    return this.transport.request<SlicerInfo>('GET', '/info');
  }
}
