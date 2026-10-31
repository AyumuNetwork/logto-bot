import type { Logger } from '../logger.js';

type TokenCache = { token: string; expiresAt: number };

export type LogtoUser = {
  id: string;
  username?: string | null;
  primaryEmail?: string | null;
  primaryPhone?: string | null;
  name?: string | null;
  avatar?: string | null;
  identities?: Record<string, { userId: string; details?: Record<string, unknown> | null }>;
  isSuspended?: boolean;
};

export type LogtoIdentityResponse = {
  identity: { userId: string; details?: Record<string, unknown> | null };
  tokenSecret?: Record<string, unknown>;
};

export type OneTimeTokenResponse = {
  id: string;
  email: string;
  token: string;
  status: 'active' | 'consumed' | 'revoked' | 'expired';
  createdAt: number;
  expiresAt: number;
  context?: Record<string, unknown>;
};

export type LogtoRole = { id: string; name: string; type: 'User' | 'MachineToMachine'; isDefault: boolean };

export type LogtoApplication = {
  id: string;
  name: string;
  type: string;
  oidcClientMetadata?: { redirectUris?: string[] };
};

export class LogtoApiError extends Error {
  override name = 'LogtoApiError';
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export type ManagementOptions = {
  endpoint: string;
  clientId?: string;
  clientSecret?: string;
  resource: string;
  logger: Logger;
  /** Optional fetch implementation (proxy-aware / dispatcher-bound). */
  fetch?: typeof fetch;
};

/**
 * Minimal Logto Management API client with a cached client-credentials token.
 */
export class LogtoManagement {
  private cache?: TokenCache;

  constructor(private readonly options: ManagementOptions) {}

  private doFetch(input: string, init?: RequestInit): Promise<Response> {
    return this.options.fetch
      ? this.options.fetch(input as never, init as never)
      : fetch(input, init);
  }

  get configured(): boolean {
    return Boolean(this.options.clientId && this.options.clientSecret);
  }

  private async getToken(): Promise<string> {
    if (!this.options.clientId || !this.options.clientSecret) {
      throw new LogtoApiError('Machine-to-machine credentials are not configured', 0, '');
    }

    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now + 30_000) {
      return this.cache.token;
    }

    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64');
    const response = await this.doFetch(`${this.options.endpoint}/oidc/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        resource: this.options.resource,
        scope: 'all',
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new LogtoApiError('Failed to obtain a Management API token', response.status, text);
    }

    const payload = JSON.parse(text) as { access_token: string; expires_in: number };
    this.cache = {
      token: payload.access_token,
      expiresAt: now + (payload.expires_in ?? 3600) * 1000,
    };
    this.options.logger.debug({ resource: this.options.resource }, 'management token refreshed');
    return this.cache.token;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getToken();
    const response = await this.doFetch(`${this.options.endpoint}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!response.ok) {
      throw new LogtoApiError(
        `Logto API ${init.method ?? 'GET'} ${path} failed`,
        response.status,
        text.slice(0, 800),
      );
    }

    return (text ? JSON.parse(text) : undefined) as T;
  }

  getUser(userId: string): Promise<LogtoUser> {
    return this.request<LogtoUser>(`/api/users/${encodeURIComponent(userId)}`);
  }

  getIdentity(userId: string, target: string): Promise<LogtoIdentityResponse> {
    return this.request<LogtoIdentityResponse>(
      `/api/users/${encodeURIComponent(userId)}/identities/${encodeURIComponent(target)}`,
    );
  }

  createOneTimeToken(input: {
    email: string;
    expiresIn: number;
    interactionEvent?: 'SignIn' | 'Register' | 'ForgotPassword';
    jitOrganizationIds?: string[];
  }): Promise<OneTimeTokenResponse> {
    const context: Record<string, unknown> = {};
    if (input.interactionEvent) {
      context.interactionEvent = input.interactionEvent;
    }
    if (input.jitOrganizationIds && input.jitOrganizationIds.length > 0) {
      context.jitOrganizationIds = input.jitOrganizationIds;
    }

    return this.request<OneTimeTokenResponse>('/api/one-time-tokens', {
      method: 'POST',
      body: JSON.stringify({
        email: input.email,
        expiresIn: input.expiresIn,
        ...(Object.keys(context).length > 0 ? { context } : {}),
      }),
    });
  }

  listOrganizations(): Promise<{ id: string; name: string }[]> {
    return this.request<{ id: string; name: string }[]>('/api/organizations?page=1&page_size=100');
  }

  listOneTimeTokens(email: string): Promise<OneTimeTokenResponse[]> {
    return this.request<OneTimeTokenResponse[]>(
      `/api/one-time-tokens?email=${encodeURIComponent(email)}&page=1&page_size=20`,
    );
  }

  deleteOneTimeToken(id: string): Promise<void> {
    return this.request<void>(`/api/one-time-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  listRoles(): Promise<LogtoRole[]> {
    return this.request<LogtoRole[]>('/api/roles?page=1&page_size=100');
  }

  getUserRoles(userId: string): Promise<LogtoRole[]> {
    return this.request<LogtoRole[]>(`/api/users/${encodeURIComponent(userId)}/roles`);
  }

  assignRoles(userId: string, roleIds: string[]): Promise<void> {
    if (roleIds.length === 0) {
      return Promise.resolve();
    }
    return this.request<void>(`/api/users/${encodeURIComponent(userId)}/roles`, {
      method: 'POST',
      body: JSON.stringify({ roleIds }),
    });
  }

  removeRole(userId: string, roleId: string): Promise<void> {
    return this.request<void>(
      `/api/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
      { method: 'DELETE' },
    );
  }

  listApplications(): Promise<LogtoApplication[]> {
    return this.request<LogtoApplication[]>('/api/applications');
  }
}
