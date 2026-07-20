export * from './types.js';
export { SlicerClient, type SlicerClientOptions } from './client.js';
export { HostGroupsAPI, VMsAPI, SecretsAPI } from './namespaces.js';
export {
  ProxyAPI,
  ProxyClientsAPI,
  ProxySecretsAPI,
  ProxyAllowsAPI,
  ProxySecretBearer,
  ProxySecretBasic,
  ProxySecretOAuthClientCredentials,
  type ProxyClient,
  type ProxyClientCreated,
  type CreateProxyClientOptions,
  type ProxySecret,
  type ProxySecretType,
  type CreateProxySecretRequest,
  type ProxyAllowRule,
  type AddProxyAllowRequest,
  type RemoveProxyAllowByTupleRequest,
} from './proxy.js';
export { VM, VMBg, VMFileSystem, type VMInit } from './vm.js';
export { resolveTransport } from './transport.js';
export {
  Forwarder,
  parseAddressMapping,
  type AddressMapping,
  type ForwarderListener,
  type ForwarderOptions,
} from './forward.js';
export {
  SlicerShellSession,
  encodeFrame,
  parseFrame,
  FRAME_TYPE_DATA,
  FRAME_TYPE_WINDOW_SIZE,
  FRAME_TYPE_SHUTDOWN,
  FRAME_TYPE_HEARTBEAT,
  FRAME_TYPE_SESSION_CLOSE,
  type ShellSessionOptions,
  type XTermLike,
} from './shell.js';
