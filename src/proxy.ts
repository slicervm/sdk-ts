/**
 * Slicer egress-proxy admin API.
 *
 * Three resources:
 *   - clients: opaque token holders. Each VM (or other consumer) presents
 *     the token via HTTPS_PROXY; the proxy resolves it to the client and
 *     walks the client's allow rules.
 *   - secrets: upstream credentials (bearer or basic). When an allow rule
 *     references a secret, the proxy strips the client's Authorization on
 *     the inner request and substitutes the secret's value.
 *   - allow rules: per-client. host (exact, *.suffix wildcard, or "*"),
 *     optional method/path filters, optional secret reference, optional
 *     TTL, optional `passthrough` (TCP-splice CONNECT, no MITM).
 *
 * Calls go through slicerd's `/proxy/v1/*` broker (the same transport
 * SlicerClient already uses for every other API), so no extra
 * configuration is needed beyond a working SlicerClient.
 *
 * Wire shapes mirror the Go SDK at github.com/slicervm/sdk/proxy.go.
 * Field-name conversion (snake_case ↔ camelCase) is handled in the
 * `*FromWire` / `*ToWire` helpers; user-facing types are camelCase.
 */

import type { TransportClient } from './transport.js';

/** Credential type for upstream injection. */
export type ProxySecretType =
  | 'bearer'
  | 'basic'
  | 'oauth-client-creds'
  | 'oauth-codex'
  | 'oauth-claude'
  | 'oauth-github-copilot'
  | 'oauth-xai'
  | 'github-app-user'
  | 'github-app';
export const ProxySecretBearer: ProxySecretType = 'bearer';
/** For basic auth, the secret value must be in `user:pass` form. */
export const ProxySecretBasic: ProxySecretType = 'basic';
/** OAuth 2.0 client credentials exchanged and renewed by the proxy host. */
export const ProxySecretOAuthClientCredentials: ProxySecretType = 'oauth-client-creds';
/** Adopt and refresh a host-side Codex ChatGPT OAuth credential. */
export const ProxySecretOAuthCodex: ProxySecretType = 'oauth-codex';
/** Adopt and refresh a host-side Claude Code OAuth credential. */
export const ProxySecretOAuthClaude: ProxySecretType = 'oauth-claude';
/** Adopt and refresh a host-side GitHub Copilot OAuth credential. */
export const ProxySecretOAuthGitHubCopilot: ProxySecretType = 'oauth-github-copilot';
/** Adopt and refresh a host-side xAI Grok OAuth credential. */
export const ProxySecretOAuthXAI: ProxySecretType = 'oauth-xai';
/** Adopt and refresh a host-side GitHub App user OAuth credential. */
export const ProxySecretGitHubAppUser: ProxySecretType = 'github-app-user';
/** Adopt a host-side GitHub App tuple and inject installation-token Git auth. */
export const ProxySecretGitHubApp: ProxySecretType = 'github-app';

/** A registered proxy client. Tokens are never returned by list/get. */
export interface ProxyClient {
  name: string;
  /** RFC 3339 timestamp. */
  createdAt: string;
}

/**
 * Returned only by `clients.create`. The token is shown once and never
 * surfaced by any other endpoint — store it now or rotate the client.
 */
export interface ProxyClientCreated {
  name: string;
  token: string;
  createdAt: string;
}

/**
 * Optional input to `clients.create`. Pass `token` to bring your own
 * literal (handy for demos and reproducible tests); omit for a
 * server-minted high-entropy `spt_…` token (recommended).
 */
export interface CreateProxyClientOptions {
  token?: string;
}

/** A registered upstream credential. `value` is never returned. */
export interface ProxySecret {
  name: string;
  host: string;
  /** Defaults to `bearer` when empty in older state files. */
  type?: ProxySecretType;
  createdAt: string;
  updatedAt?: string;
  adoptedAt?: string;
  refreshedAt?: string;
}

export interface CreateProxySecretRequest {
  name: string;
  host: string;
  /** Defaults to `bearer` when omitted. */
  type?: ProxySecretType;
  /**
   * Plaintext credential. For `bearer`, the raw token. For `basic`,
   * must be in `user:pass` form (the proxy base64-encodes it on the
   * inner request). For `oauth-client-creds`, pass top-level JSON containing
   * `token_endpoint`, `client_id`, and `client_secret`; optional `scope` is
   * supported. The proxy obtains, caches, and renews the bearer host-side.
   * For `oauth-codex`, pass a Codex auth.json or
   * minimal OAuth JSON containing access_token, refresh_token, and
   * account_id. For `oauth-claude`, pass Claude Code's .credentials.json
   * or minimal OAuth JSON containing accessToken and refreshToken. For
   * `oauth-github-copilot`, pass opencode auth.json or minimal OAuth JSON
   * containing a GitHub Copilot gho_* or ghu_* token. For `oauth-xai`, pass JSON
   * emitted by `slicer proxy oauth xai`, or equivalent top-level JSON
   * containing access_token and refresh_token. For `github-app-user`, pass
   * JSON emitted by `slicer proxy oauth github-app-user`, or equivalent
   * top-level JSON containing access_token. The proxy stores and refreshes
   * OAuth credentials host-side. For `github-app`, pass top-level JSON
   * containing app_id and either private_key_file or private_key. With
   * private_key_file, the proxy keeps the PEM file on the host; with
   * private_key, the PEM is stored in proxy state. The proxy mints GitHub App
   * installation tokens in memory and injects Git HTTPS Basic auth for
   * github.com clone/fetch requests.
   */
  value: string;
  /**
   * Overwrite an existing secret with the same name. Useful after the
   * host-side OAuth login has been refreshed manually and the proxy
   * should re-adopt the credential without rewriting allow rules.
   */
  force?: boolean;
}

/**
 * Per-client allow entry. First-match-wins by declaration order.
 *
 * - When `secret` is set, the proxy strips the client's Authorization
 *   on the inner request and substitutes the secret's value.
 * - `methods`/`paths` are optional filters (any-of within each list,
 *   all-of across lists). Empty list = any.
 * - `ports` is optional. Empty means the default web ports 80 and 443
 *   for backwards compatibility with older host-only rules.
 * - When `passthrough` is true, the proxy splices TCP both ways at
 *   CONNECT without terminating TLS. Cert-pinned clients work
 *   unchanged. Mutually exclusive with `secret`, `methods`, `paths`;
 *   the admin API rejects rules that combine them.
 */
export interface ProxyAllowRule {
  host: string;
  secret?: string;
  methods?: string[];
  paths?: string[];
  ports?: number[];
  /** RFC 3339 timestamp; absent / zero-value when no expiry. */
  expires?: string;
  passthrough?: boolean;
}

/** Input to `allows.add`. */
export interface AddProxyAllowRequest {
  client: string;
  host: string;
  secret?: string;
  methods?: string[];
  paths?: string[];
  ports?: number[];
  /**
   * Time-to-live in seconds. 0 / omitted = never expires. Resolved to
   * an absolute `expires` timestamp on the returned rule.
   */
  ttlSeconds?: number;
  /** See ProxyAllowRule.passthrough. Mutually exclusive with secret/methods/paths. */
  passthrough?: boolean;
}

/**
 * Input to `allows.removeByTuple`. Mirrors the create payload minus
 * `ttlSeconds` (TTL is mutable lifetime, not part of identity). The
 * proxy matches the rule by (host, methods, paths, ports, passthrough) and
 * removes the single matching rule. Use when several rules share a
 * host and you want surgical removal of one — pass exactly the same
 * fields you used at create time.
 */
export interface RemoveProxyAllowByTupleRequest {
  client: string;
  host: string;
  secret?: string;
  methods?: string[];
  paths?: string[];
  ports?: number[];
  passthrough?: boolean;
}

// ───── wire types (snake_case JSON shapes from the daemon) ─────

interface WireProxyClient {
  name: string;
  created_at: string;
}

interface WireProxyClientCreated {
  name: string;
  token: string;
  created_at: string;
}

interface WireProxySecret {
  name: string;
  host: string;
  type?: string;
  created_at: string;
  updated_at?: string;
  adopted_at?: string;
  refreshed_at?: string;
}

interface WireProxyAllowRule {
  host: string;
  secret?: string;
  methods?: string[];
  paths?: string[];
  ports?: number[];
  expires?: string;
  passthrough?: boolean;
}

function clientFromWire(w: WireProxyClient): ProxyClient {
  return { name: w.name, createdAt: w.created_at };
}

function clientCreatedFromWire(w: WireProxyClientCreated): ProxyClientCreated {
  return { name: w.name, token: w.token, createdAt: w.created_at };
}

function secretFromWire(w: WireProxySecret): ProxySecret {
  const out: ProxySecret = { name: w.name, host: w.host, createdAt: w.created_at };
  if (w.type) out.type = w.type as ProxySecretType;
  if (w.updated_at && w.updated_at !== '0001-01-01T00:00:00Z') out.updatedAt = w.updated_at;
  if (w.adopted_at && w.adopted_at !== '0001-01-01T00:00:00Z') out.adoptedAt = w.adopted_at;
  if (w.refreshed_at && w.refreshed_at !== '0001-01-01T00:00:00Z') out.refreshedAt = w.refreshed_at;
  return out;
}

function ruleFromWire(w: WireProxyAllowRule): ProxyAllowRule {
  const out: ProxyAllowRule = { host: w.host };
  if (w.secret) out.secret = w.secret;
  if (w.methods && w.methods.length > 0) out.methods = w.methods;
  if (w.paths && w.paths.length > 0) out.paths = w.paths;
  if (w.ports && w.ports.length > 0) out.ports = w.ports;
  if (w.expires && w.expires !== '0001-01-01T00:00:00Z') out.expires = w.expires;
  if (w.passthrough) out.passthrough = w.passthrough;
  return out;
}

// ───── API class ─────

export class ProxyAPI {
  readonly clients: ProxyClientsAPI;
  readonly secrets: ProxySecretsAPI;
  readonly allows: ProxyAllowsAPI;

  constructor(private readonly transport: TransportClient) {
    this.clients = new ProxyClientsAPI(transport);
    this.secrets = new ProxySecretsAPI(transport);
    this.allows = new ProxyAllowsAPI(transport);
  }
}

export class ProxyClientsAPI {
  constructor(private readonly transport: TransportClient) {}

  /** Mint a new proxy client. The returned token is shown once. */
  async create(name: string, opts: CreateProxyClientOptions = {}): Promise<ProxyClientCreated> {
    const body: Record<string, unknown> = { name };
    if (opts.token) body.token = opts.token;
    const wire = await this.transport.request<WireProxyClientCreated>(
      'POST',
      '/proxy/v1/clients',
      body,
    );
    return clientCreatedFromWire(wire);
  }

  async list(): Promise<ProxyClient[]> {
    const wire = await this.transport.request<WireProxyClient[]>('GET', '/proxy/v1/clients');
    return (wire ?? []).map(clientFromWire);
  }

  /**
   * Revoke the token, drop every allow rule the client owned, and
   * remove the client.
   */
  async delete(name: string): Promise<void> {
    await this.transport.request('DELETE', `/proxy/v1/clients/${encodeURIComponent(name)}`);
  }

  /** List a client's allow rules in declaration order (first-match-wins). */
  async rules(name: string): Promise<ProxyAllowRule[]> {
    const wire = await this.transport.request<WireProxyAllowRule[]>(
      'GET',
      `/proxy/v1/clients/${encodeURIComponent(name)}`,
    );
    return (wire ?? []).map(ruleFromWire);
  }
}

export class ProxySecretsAPI {
  constructor(private readonly transport: TransportClient) {}

  async create(req: CreateProxySecretRequest): Promise<void> {
    const body: Record<string, unknown> = {
      name: req.name,
      host: req.host,
      value: req.value,
    };
    if (req.type) body.type = req.type;
    if (req.force) body.force = true;
    await this.transport.request('POST', '/proxy/v1/secrets', body);
  }

  async list(): Promise<ProxySecret[]> {
    const wire = await this.transport.request<WireProxySecret[]>('GET', '/proxy/v1/secrets');
    return (wire ?? []).map(secretFromWire);
  }

  /**
   * Remove a secret. Allow rules that reference it stop matching until
   * the secret is recreated or the rule is rewritten.
   */
  async delete(name: string): Promise<void> {
    await this.transport.request('DELETE', `/proxy/v1/secrets/${encodeURIComponent(name)}`);
  }
}

export class ProxyAllowsAPI {
  constructor(private readonly transport: TransportClient) {}

  /** Add an allow rule. Returns the resolved rule with absolute `expires`. */
  async add(req: AddProxyAllowRequest): Promise<ProxyAllowRule> {
    const body: Record<string, unknown> = {
      client: req.client,
      host: req.host,
    };
    if (req.secret) body.secret = req.secret;
    if (req.methods && req.methods.length > 0) body.methods = req.methods;
    if (req.paths && req.paths.length > 0) body.paths = req.paths;
    if (req.ports && req.ports.length > 0) body.ports = req.ports;
    if (req.ttlSeconds && req.ttlSeconds > 0) body.ttl_seconds = req.ttlSeconds;
    if (req.passthrough) body.passthrough = true;
    const wire = await this.transport.request<WireProxyAllowRule>(
      'POST',
      '/proxy/v1/allows',
      body,
    );
    return ruleFromWire(wire);
  }

  /**
   * Host-bulk revoke: removes **every** rule on the client whose host
   * matches. For surgical removal of one rule among siblings on the
   * same host (e.g. several path-scoped rules on `github.com`), use
   * `removeByTuple` instead.
   */
  async remove(client: string, host: string): Promise<void> {
    await this.transport.request(
      'DELETE',
      `/proxy/v1/allows/${encodeURIComponent(client)}/${encodeURIComponent(host)}`,
    );
  }

  /**
   * Surgical revoke: removes the single rule whose
   * (host, methods, paths, ports, passthrough) tuple matches the request.
   * Pass exactly the same fields you used at create time. Method and
   * host casing are normalised server-side, so `"GET"` / `"get"` and
   * `"github.com"` / `"GITHUB.COM"` all match the same stored rule.
   *
   * Returns 404 (surfaced as a SlicerAPIError) when no rule matches.
   */
  async removeByTuple(req: RemoveProxyAllowByTupleRequest): Promise<void> {
    const body: Record<string, unknown> = {
      client: req.client,
      host: req.host,
    };
    if (req.secret) body.secret = req.secret;
    if (req.methods && req.methods.length > 0) body.methods = req.methods;
    if (req.paths && req.paths.length > 0) body.paths = req.paths;
    if (req.ports && req.ports.length > 0) body.ports = req.ports;
    if (req.passthrough) body.passthrough = true;
    await this.transport.request('POST', '/proxy/v1/allows/revoke', body);
  }
}
