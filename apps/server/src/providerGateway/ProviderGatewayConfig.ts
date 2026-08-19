import {
  WORKJET_GATEWAY_API_KEY_MAX_LENGTH,
  WorkjetGatewayAccountId,
  WorkjetGatewayPoolId,
  WorkjetGatewayRouteId,
  type WorkjetGatewayAccountSummary,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayModelSummary,
  type WorkjetGatewayPoolSummary,
  type WorkjetGatewayApiKeyProvider,
  type WorkjetGatewayProvider,
  type WorkjetGatewayRouteSummary,
} from "@t3tools/contracts";

export const GATEWAY_SECRET_SCOPE = "workjet-provider-gateway";
export const MANAGEMENT_SECRET_NAME = "management";
const MAX_ACCOUNTS = 64;
const MAX_MODELS = 256;
const MAX_TEXT = 160;

export interface GatewaySecretReference {
  readonly scope: typeof GATEWAY_SECRET_SCOPE;
  readonly name: string;
}

interface GatewayAccountBase {
  readonly id: string;
  readonly label: string;
  readonly provider: WorkjetGatewayProvider;
  readonly enabled: boolean;
  readonly priority: number;
  readonly weight: number;
  readonly models: ReadonlyArray<string>;
  readonly proxyUrlSecret?: GatewaySecretReference;
}

export interface ClaudeGatewayAccount extends GatewayAccountBase {
  readonly provider: "claude";
  readonly accessTokenSecret: GatewaySecretReference;
  readonly refreshTokenSecret: GatewaySecretReference;
  readonly upstreamScheme?: string;
  readonly upstreamAuthority?: string;
  readonly timezone?: string;
}

export interface CodexGatewayAccount extends GatewayAccountBase {
  readonly provider: "codex";
  readonly idTokenSecret: GatewaySecretReference;
  readonly accessTokenSecret: GatewaySecretReference;
  readonly refreshTokenSecret: GatewaySecretReference;
  readonly upstreamBaseUrl?: string;
  readonly planType?: string;
}

export interface AntigravityGatewayAccount extends GatewayAccountBase {
  readonly provider: "antigravity";
  readonly accessTokenSecret: GatewaySecretReference;
  readonly refreshTokenSecret: GatewaySecretReference;
  readonly stateSecret: GatewaySecretReference;
  readonly upstreamBaseUrl?: string;
}

/**
 * An account whose only credential is a user-pasted API key. The key itself is
 * never part of this record: `apiKeySecret` is a reference into the server
 * secret store, exactly like every OAuth token reference above.
 *
 * `credentialSuffix` is the last few characters of the key, kept so the
 * settings list can show which key an account carries without the gateway ever
 * reading the secret back for display.
 */
export interface ApiKeyGatewayAccount extends GatewayAccountBase {
  readonly provider: WorkjetGatewayApiKeyProvider;
  readonly apiKeySecret: GatewaySecretReference;
  readonly upstreamBaseUrl?: string;
  readonly credentialSuffix?: string;
}

export type GatewayAccount =
  | ClaudeGatewayAccount
  | CodexGatewayAccount
  | AntigravityGatewayAccount
  | ApiKeyGatewayAccount;

/** Kept in lockstep with the Rust host's `API_KEY_PROVIDERS`. */
export const API_KEY_PROVIDERS = ["zai", "minimax", "xai", "kimi"] as const;

export const isApiKeyProvider = (
  value: WorkjetGatewayProvider,
): value is WorkjetGatewayApiKeyProvider =>
  (API_KEY_PROVIDERS as ReadonlyArray<string>).includes(value);

export const isApiKeyAccount = (account: GatewayAccount): account is ApiKeyGatewayAccount =>
  isApiKeyProvider(account.provider);

/**
 * Longest suffix kept for recognition. Four characters identify a key for a
 * human without narrowing the secret in any useful way.
 */
export const CREDENTIAL_SUFFIX_LENGTH = 4;

export const credentialSuffix = (apiKey: string): string | undefined => {
  const trimmed = apiKey.trim();
  return trimmed.length > CREDENTIAL_SUFFIX_LENGTH
    ? trimmed.slice(-CREDENTIAL_SUFFIX_LENGTH)
    : undefined;
};

/** Bounded exactly like the contract, so the server never trusts the client. */
export const isAcceptableApiKey = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= WORKJET_GATEWAY_API_KEY_MAX_LENGTH &&
  // A control character could split an outgoing header on the Rust side.
  ![...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

export interface ProviderGatewayConfiguration {
  readonly schemaVersion: 1;
  readonly defaultProvider: WorkjetGatewayProvider;
  readonly accounts: ReadonlyArray<GatewayAccount>;
  readonly pools: ReadonlyArray<WorkjetGatewayPoolSummary>;
  readonly routes: ReadonlyArray<WorkjetGatewayRouteSummary>;
  /**
   * Stable loopback port for the provider endpoint. Allocated once and then
   * persisted so harness sessions routed through the gateway survive gateway
   * restarts; absent means an ephemeral port.
   */
  readonly providerPort?: number;
  readonly antigravityOauth?: {
    readonly clientIdSecret: GatewaySecretReference;
    readonly clientSecretSecret: GatewaySecretReference;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlyArray<string>): boolean => {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
};
const unique = (values: ReadonlyArray<string>): boolean => new Set(values).size === values.length;
const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_TEXT ? trimmed : undefined;
};
const PROVIDERS: ReadonlyArray<WorkjetGatewayProvider> = [
  "claude",
  "codex",
  "antigravity",
  ...API_KEY_PROVIDERS,
];
const provider = (value: unknown): WorkjetGatewayProvider | undefined =>
  typeof value === "string" && (PROVIDERS as ReadonlyArray<string>).includes(value)
    ? (value as WorkjetGatewayProvider)
    : undefined;
const secretReference = (value: unknown): GatewaySecretReference | undefined => {
  if (!isRecord(value) || value.scope !== GATEWAY_SECRET_SCOPE) return undefined;
  const name = text(value.name);
  if (name === undefined || name.includes("..") || !/^[A-Za-z0-9._-]+$/.test(name)) {
    return undefined;
  }
  return { scope: GATEWAY_SECRET_SCOPE, name };
};
const modelIds = (value: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value) || value.length > MAX_MODELS) return undefined;
  const models = value.map(text);
  if (models.some((model) => model === undefined)) return undefined;
  return [...new Set(models as ReadonlyArray<string>)];
};

const ACCOUNT_COMMON_KEYS = [
  "id",
  "label",
  "provider",
  "enabled",
  "priority",
  "weight",
  "models",
  "proxyUrlSecret",
] as const;

/**
 * An OAuth account is identified by its token references; an API-key account
 * carries `apiKeySecret` instead and must NOT carry token references, so a
 * malformed hybrid record can never decode.
 */
const OAUTH_ACCOUNT_KEYS = ["accessTokenSecret", "refreshTokenSecret"] as const;

interface CommonAccountFields {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly weight: number;
  readonly models: ReadonlyArray<string>;
  readonly proxyUrlSecret?: GatewaySecretReference;
}

/** The fields every account kind shares, validated once. */
const parseCommonAccountFields = (
  value: Record<string, unknown>,
): CommonAccountFields | undefined => {
  const id = text(value.id);
  const label = text(value.label);
  const models = modelIds(value.models);
  const priority = value.priority === undefined ? 0 : value.priority;
  const weight = value.weight === undefined ? 1 : value.weight;
  const proxyUrlSecret =
    value.proxyUrlSecret === undefined ? undefined : secretReference(value.proxyUrlSecret);
  if (
    id === undefined ||
    label === undefined ||
    models === undefined ||
    (value.enabled !== undefined && typeof value.enabled !== "boolean") ||
    typeof priority !== "number" ||
    !Number.isSafeInteger(priority) ||
    Math.abs(priority) > 10_000 ||
    typeof weight !== "number" ||
    !Number.isSafeInteger(weight) ||
    weight <= 0 ||
    weight > 10_000 ||
    (value.proxyUrlSecret !== undefined && proxyUrlSecret === undefined)
  ) {
    return undefined;
  }
  return {
    id,
    label,
    enabled: value.enabled !== false,
    priority,
    weight,
    models,
    ...(proxyUrlSecret ? { proxyUrlSecret } : {}),
  };
};

const API_KEY_ACCOUNT_KEYS = ["apiKeySecret", "upstreamBaseUrl", "credentialSuffix"] as const;

/**
 * An API-key account decodes only when it carries a secret REFERENCE and no
 * OAuth token reference at all. A record with a literal key field, or with a
 * suffix longer than the recognition length, is refused: a configuration file
 * must never be able to hold credential material.
 */
const parseApiKeyAccount = (
  value: Record<string, unknown>,
  accountProvider: WorkjetGatewayApiKeyProvider,
): ApiKeyGatewayAccount | undefined => {
  if (!hasOnlyKeys(value, [...ACCOUNT_COMMON_KEYS, ...API_KEY_ACCOUNT_KEYS])) return undefined;
  const common = parseCommonAccountFields(value);
  const apiKeySecret = secretReference(value.apiKeySecret);
  const upstreamBaseUrl =
    value.upstreamBaseUrl === undefined ? undefined : text(value.upstreamBaseUrl);
  const suffix = value.credentialSuffix;
  if (
    common === undefined ||
    apiKeySecret === undefined ||
    (value.upstreamBaseUrl !== undefined &&
      (upstreamBaseUrl === undefined || !upstreamBaseUrl.startsWith("https://"))) ||
    (suffix !== undefined &&
      (typeof suffix !== "string" ||
        suffix.length === 0 ||
        suffix.length > CREDENTIAL_SUFFIX_LENGTH))
  ) {
    return undefined;
  }
  return {
    ...common,
    provider: accountProvider,
    apiKeySecret,
    ...(upstreamBaseUrl ? { upstreamBaseUrl } : {}),
    ...(typeof suffix === "string" ? { credentialSuffix: suffix } : {}),
  };
};

const parseAccount = (value: unknown): GatewayAccount | undefined => {
  if (!isRecord(value)) return undefined;
  const accountProvider = provider(value.provider);
  if (accountProvider === undefined) return undefined;
  if (isApiKeyProvider(accountProvider)) {
    return parseApiKeyAccount(value, accountProvider);
  }
  const providerKeys =
    accountProvider === "claude"
      ? ["upstreamScheme", "upstreamAuthority", "timezone"]
      : accountProvider === "codex"
        ? ["idTokenSecret", "upstreamBaseUrl", "planType"]
        : ["stateSecret", "upstreamBaseUrl"];
  if (!hasOnlyKeys(value, [...ACCOUNT_COMMON_KEYS, ...OAUTH_ACCOUNT_KEYS, ...providerKeys])) {
    return undefined;
  }
  const common = parseCommonAccountFields(value);
  const accessTokenSecret = secretReference(value.accessTokenSecret);
  const refreshTokenSecret = secretReference(value.refreshTokenSecret);
  if (common === undefined || accessTokenSecret === undefined || refreshTokenSecret === undefined) {
    return undefined;
  }
  if (accountProvider === "claude") {
    const upstreamScheme =
      value.upstreamScheme === undefined ? undefined : text(value.upstreamScheme);
    const upstreamAuthority =
      value.upstreamAuthority === undefined ? undefined : text(value.upstreamAuthority);
    const timezone = value.timezone === undefined ? undefined : text(value.timezone);
    if (
      (value.upstreamScheme !== undefined && upstreamScheme === undefined) ||
      (value.upstreamAuthority !== undefined && upstreamAuthority === undefined) ||
      (value.timezone !== undefined && timezone === undefined)
    ) {
      return undefined;
    }
    return {
      ...common,
      provider: "claude",
      accessTokenSecret,
      refreshTokenSecret,
      ...(upstreamScheme ? { upstreamScheme } : {}),
      ...(upstreamAuthority ? { upstreamAuthority } : {}),
      ...(timezone ? { timezone } : {}),
    };
  }
  if (accountProvider === "codex") {
    const idTokenSecret = secretReference(value.idTokenSecret);
    const upstreamBaseUrl =
      value.upstreamBaseUrl === undefined ? undefined : text(value.upstreamBaseUrl);
    const planType = value.planType === undefined ? undefined : text(value.planType);
    if (
      idTokenSecret === undefined ||
      (value.upstreamBaseUrl !== undefined && upstreamBaseUrl === undefined) ||
      (value.planType !== undefined && planType === undefined)
    ) {
      return undefined;
    }
    return {
      ...common,
      provider: "codex",
      idTokenSecret,
      accessTokenSecret,
      refreshTokenSecret,
      ...(upstreamBaseUrl ? { upstreamBaseUrl } : {}),
      ...(planType ? { planType } : {}),
    };
  }
  const stateSecret = secretReference(value.stateSecret);
  const upstreamBaseUrl =
    value.upstreamBaseUrl === undefined ? undefined : text(value.upstreamBaseUrl);
  if (
    stateSecret === undefined ||
    (value.upstreamBaseUrl !== undefined && upstreamBaseUrl === undefined)
  ) {
    return undefined;
  }
  return {
    ...common,
    provider: "antigravity",
    accessTokenSecret,
    refreshTokenSecret,
    stateSecret,
    ...(upstreamBaseUrl ? { upstreamBaseUrl } : {}),
  };
};

const parsePools = (
  value: unknown,
  accounts: ReadonlyArray<GatewayAccount>,
): ReadonlyArray<WorkjetGatewayPoolSummary> | undefined => {
  if (!Array.isArray(value) || value.length > MAX_ACCOUNTS) return undefined;
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const pools: Array<WorkjetGatewayPoolSummary> = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ["id", "label", "provider", "accountIds", "modelIds"])
    ) {
      return undefined;
    }
    const id = text(entry.id);
    const label = text(entry.label);
    const poolProvider = provider(entry.provider);
    const models = modelIds(entry.modelIds);
    if (
      !Array.isArray(entry.accountIds) ||
      id === undefined ||
      label === undefined ||
      poolProvider === undefined ||
      models === undefined
    ) {
      return undefined;
    }
    const accountIds = entry.accountIds.map(text);
    const definedAccountIds = accountIds as Array<string>;
    if (
      accountIds.some((accountId) => accountId === undefined) ||
      !unique(definedAccountIds) ||
      definedAccountIds.some((accountId) => accountById.get(accountId)?.provider !== poolProvider)
    ) {
      return undefined;
    }
    pools.push({
      id: WorkjetGatewayPoolId.make(id),
      label,
      provider: poolProvider,
      accountIds: definedAccountIds.map((accountId) => WorkjetGatewayAccountId.make(accountId)),
      modelIds: models,
    });
  }
  return unique(pools.map((pool) => pool.id)) ? pools : undefined;
};

const parseRoutes = (
  value: unknown,
  pools: ReadonlyArray<WorkjetGatewayPoolSummary>,
): ReadonlyArray<WorkjetGatewayRouteSummary> | undefined => {
  if (!Array.isArray(value) || value.length > MAX_ACCOUNTS) return undefined;
  const poolById = new Map<string, WorkjetGatewayPoolSummary>();
  for (const pool of pools) poolById.set(pool.id, pool);
  const routes: Array<WorkjetGatewayRouteSummary> = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ["id", "label", "poolId", "provider", "modelIds"])
    ) {
      return undefined;
    }
    const id = text(entry.id);
    const label = text(entry.label);
    const poolId = text(entry.poolId);
    const routeProvider = provider(entry.provider);
    const models = modelIds(entry.modelIds);
    if (
      id === undefined ||
      label === undefined ||
      poolId === undefined ||
      routeProvider === undefined ||
      models === undefined ||
      poolById.get(poolId)?.provider !== routeProvider
    ) {
      return undefined;
    }
    routes.push({
      id: WorkjetGatewayRouteId.make(id),
      label,
      poolId: WorkjetGatewayPoolId.make(poolId),
      provider: routeProvider,
      modelIds: models,
    });
  }
  return unique(routes.map((route) => route.id)) ? routes : undefined;
};

export const decodeProviderGatewayConfiguration = (
  value: unknown,
): ProviderGatewayConfiguration | undefined => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "defaultProvider",
      "accounts",
      "pools",
      "routes",
      "providerPort",
      "antigravityOauth",
    ])
  ) {
    return undefined;
  }
  const defaultProvider = provider(value.defaultProvider);
  if (
    !Array.isArray(value.accounts) ||
    value.accounts.length > MAX_ACCOUNTS ||
    defaultProvider === undefined
  ) {
    return undefined;
  }
  const providerPort = value.providerPort;
  if (
    providerPort !== undefined &&
    (typeof providerPort !== "number" ||
      !Number.isSafeInteger(providerPort) ||
      providerPort < 1024 ||
      providerPort > 65_535)
  ) {
    return undefined;
  }
  const accounts = value.accounts.map(parseAccount);
  if (accounts.some((account) => account === undefined)) return undefined;
  const typedAccounts = accounts as ReadonlyArray<GatewayAccount>;
  // An empty account list is a valid bootstrap state: the host starts with
  // only the management/OAuth surface so the first login can happen at all.
  if (
    !unique(typedAccounts.map((account) => account.id)) ||
    (typedAccounts.length > 0 &&
      !typedAccounts.some((account) => account.enabled && account.provider === defaultProvider))
  ) {
    return undefined;
  }
  const pools = parsePools(value.pools ?? [], typedAccounts);
  if (pools === undefined) return undefined;
  const routes = parseRoutes(value.routes ?? [], pools);
  if (routes === undefined) return undefined;
  const hasAntigravity = typedAccounts.some((account) => account.provider === "antigravity");
  let antigravityOauth: ProviderGatewayConfiguration["antigravityOauth"];
  if (!hasAntigravity && value.antigravityOauth !== undefined) return undefined;
  if (hasAntigravity) {
    if (
      !isRecord(value.antigravityOauth) ||
      !hasOnlyKeys(value.antigravityOauth, ["clientIdSecret", "clientSecretSecret"])
    ) {
      return undefined;
    }
    const clientIdSecret = secretReference(value.antigravityOauth.clientIdSecret);
    const clientSecretSecret = secretReference(value.antigravityOauth.clientSecretSecret);
    if (clientIdSecret === undefined || clientSecretSecret === undefined) return undefined;
    antigravityOauth = { clientIdSecret, clientSecretSecret };
  }
  return {
    schemaVersion: 1,
    defaultProvider,
    accounts: typedAccounts,
    pools,
    routes,
    ...(providerPort !== undefined ? { providerPort } : {}),
    ...(antigravityOauth ? { antigravityOauth } : {}),
  };
};

export const secretStoreName = (reference: GatewaySecretReference): string =>
  `${reference.scope}.${reference.name}`;

export const accountSecretReferences = (
  account: GatewayAccount,
): ReadonlyArray<GatewaySecretReference> => {
  const references: Array<GatewaySecretReference> = isApiKeyAccount(account)
    ? [account.apiKeySecret]
    : [account.accessTokenSecret, account.refreshTokenSecret];
  if (account.provider === "codex") references.unshift(account.idTokenSecret);
  if (account.provider === "antigravity") references.push(account.stateSecret);
  if (account.proxyUrlSecret) references.push(account.proxyUrlSecret);
  return references;
};

export const gatewayCatalog = (
  configuration: ProviderGatewayConfiguration,
): WorkjetGatewayCatalog => {
  const accounts: Array<WorkjetGatewayAccountSummary> = configuration.accounts.map((account) => ({
    id: WorkjetGatewayAccountId.make(account.id),
    label: account.label,
    provider: account.provider,
    enabled: account.enabled,
    priority: account.priority,
    weight: account.weight,
    modelIds: account.models,
    // The only credential-derived value any read route carries.
    credentialSuffix: isApiKeyAccount(account) ? (account.credentialSuffix ?? null) : null,
  }));
  const modelMap = new Map<
    string,
    { providers: Set<WorkjetGatewayProvider>; accountIds: Set<string> }
  >();
  for (const account of configuration.accounts) {
    for (const model of account.models) {
      const entry = modelMap.get(model) ?? { providers: new Set(), accountIds: new Set() };
      entry.providers.add(account.provider);
      entry.accountIds.add(account.id);
      modelMap.set(model, entry);
    }
  }
  const models: Array<WorkjetGatewayModelSummary> = [...modelMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_MODELS)
    .map(([id, entry]) => ({
      id,
      displayName: id,
      providers: [...entry.providers].sort(),
      accountIds: [...entry.accountIds].sort().map((id) => WorkjetGatewayAccountId.make(id)),
    }));
  return {
    schemaVersion: 1,
    accounts,
    pools: configuration.pools,
    routes: configuration.routes,
    models,
  };
};

export const rustHostConfiguration = (
  configuration: ProviderGatewayConfiguration,
  secretRoot: string,
) => ({
  schema: "workjet.provider-gateway-host.v1",
  providerAddress: `127.0.0.1:${configuration.providerPort ?? 0}`,
  managementAddress: "127.0.0.1:0",
  secretRoot,
  managementSecret: { scope: GATEWAY_SECRET_SCOPE, name: MANAGEMENT_SECRET_NAME },
  ...(configuration.antigravityOauth
    ? {
        antigravityOauthClientIdSecret: configuration.antigravityOauth.clientIdSecret,
        antigravityOauthClientSecretSecret: configuration.antigravityOauth.clientSecretSecret,
      }
    : {}),
  // A bootstrap host with zero accounts must not name a default provider; the
  // host rejects that combination.
  ...(configuration.accounts.length > 0 ? { defaultProvider: configuration.defaultProvider } : {}),
  runtime: {
    request_timeout_ms: 30_000,
    routing_strategy: "round-robin",
    claude_accounts: configuration.accounts
      .filter((account): account is ClaudeGatewayAccount => account.provider === "claude")
      .map((account) => ({
        id: account.id,
        disabled: !account.enabled,
        priority: account.priority,
        weight: account.weight,
        websockets: false,
        models: account.models,
        access_token_secret: account.accessTokenSecret,
        refresh_token_secret: account.refreshTokenSecret,
        upstream_scheme: account.upstreamScheme ?? "https",
        upstream_authority: account.upstreamAuthority ?? "api.anthropic.com",
        ...(account.proxyUrlSecret ? { proxy_url_secret: account.proxyUrlSecret } : {}),
        timezone: account.timezone ?? "",
      })),
    codex_accounts: configuration.accounts
      .filter((account): account is CodexGatewayAccount => account.provider === "codex")
      .map((account) => ({
        id: account.id,
        disabled: !account.enabled,
        priority: account.priority,
        weight: account.weight,
        websockets: false,
        models: account.models,
        id_token_secret: account.idTokenSecret,
        access_token_secret: account.accessTokenSecret,
        refresh_token_secret: account.refreshTokenSecret,
        upstream_base_url: account.upstreamBaseUrl ?? "https://chatgpt.com/backend-api/codex",
        plan_type: account.planType ?? "",
        ...(account.proxyUrlSecret ? { proxy_url_secret: account.proxyUrlSecret } : {}),
      })),
    antigravity_accounts: configuration.accounts
      .filter((account): account is AntigravityGatewayAccount => account.provider === "antigravity")
      .map((account) => ({
        id: account.id,
        disabled: !account.enabled,
        priority: account.priority,
        weight: account.weight,
        websockets: false,
        models: account.models,
        access_token_secret: account.accessTokenSecret,
        refresh_token_secret: account.refreshTokenSecret,
        state_secret: account.stateSecret,
        upstream_base_url: account.upstreamBaseUrl ?? "https://cloudcode-pa.googleapis.com",
        ...(account.proxyUrlSecret ? { proxy_url_secret: account.proxyUrlSecret } : {}),
      })),
    // API-key accounts. The base URL is left empty when the user did not
    // override it, so the Rust host applies its own per-provider default (the
    // single place where each endpoint and its evidence level are recorded).
    api_key_accounts: configuration.accounts.filter(isApiKeyAccount).map((account) => ({
      id: account.id,
      provider: account.provider,
      disabled: !account.enabled,
      priority: account.priority,
      weight: account.weight,
      models: account.models,
      api_key_secret: account.apiKeySecret,
      upstream_base_url: account.upstreamBaseUrl ?? "",
      ...(account.proxyUrlSecret ? { proxy_url_secret: account.proxyUrlSecret } : {}),
    })),
  },
});
