import {
  WorkjetGatewayAccountId,
  WorkjetGatewayPoolId,
  WorkjetGatewayRouteId,
  type WorkjetGatewayAccountSummary,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayModelSummary,
  type WorkjetGatewayPoolSummary,
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

export type GatewayAccount = ClaudeGatewayAccount | CodexGatewayAccount | AntigravityGatewayAccount;

export interface ProviderGatewayConfiguration {
  readonly schemaVersion: 1;
  readonly defaultProvider: WorkjetGatewayProvider;
  readonly accounts: ReadonlyArray<GatewayAccount>;
  readonly pools: ReadonlyArray<WorkjetGatewayPoolSummary>;
  readonly routes: ReadonlyArray<WorkjetGatewayRouteSummary>;
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
const provider = (value: unknown): WorkjetGatewayProvider | undefined =>
  value === "claude" || value === "codex" || value === "antigravity" ? value : undefined;
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
  "accessTokenSecret",
  "refreshTokenSecret",
] as const;

const parseAccount = (value: unknown): GatewayAccount | undefined => {
  if (!isRecord(value)) return undefined;
  const accountProvider = provider(value.provider);
  const providerKeys =
    accountProvider === "claude"
      ? ["upstreamScheme", "upstreamAuthority", "timezone"]
      : accountProvider === "codex"
        ? ["idTokenSecret", "upstreamBaseUrl", "planType"]
        : accountProvider === "antigravity"
          ? ["stateSecret", "upstreamBaseUrl"]
          : [];
  if (
    accountProvider === undefined ||
    !hasOnlyKeys(value, [...ACCOUNT_COMMON_KEYS, ...providerKeys])
  ) {
    return undefined;
  }
  const id = text(value.id);
  const label = text(value.label);
  const models = modelIds(value.models);
  const priority = value.priority === undefined ? 0 : value.priority;
  const weight = value.weight === undefined ? 1 : value.weight;
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
    weight > 10_000
  ) {
    return undefined;
  }
  const proxyUrlSecret =
    value.proxyUrlSecret === undefined ? undefined : secretReference(value.proxyUrlSecret);
  const accessTokenSecret = secretReference(value.accessTokenSecret);
  const refreshTokenSecret = secretReference(value.refreshTokenSecret);
  if (
    (value.proxyUrlSecret !== undefined && proxyUrlSecret === undefined) ||
    accessTokenSecret === undefined ||
    refreshTokenSecret === undefined
  ) {
    return undefined;
  }
  const common = {
    id,
    label,
    enabled: value.enabled !== false,
    priority,
    weight,
    models,
    ...(proxyUrlSecret ? { proxyUrlSecret } : {}),
  };
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
    ...(antigravityOauth ? { antigravityOauth } : {}),
  };
};

export const secretStoreName = (reference: GatewaySecretReference): string =>
  `${reference.scope}.${reference.name}`;

export const accountSecretReferences = (
  account: GatewayAccount,
): ReadonlyArray<GatewaySecretReference> => {
  const references = [account.accessTokenSecret, account.refreshTokenSecret];
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
  providerAddress: "127.0.0.1:0",
  managementAddress: "127.0.0.1:0",
  secretRoot,
  managementSecret: { scope: GATEWAY_SECRET_SCOPE, name: MANAGEMENT_SECRET_NAME },
  ...(configuration.antigravityOauth
    ? {
        antigravityOauthClientIdSecret: configuration.antigravityOauth.clientIdSecret,
        antigravityOauthClientSecretSecret: configuration.antigravityOauth.clientSecretSecret,
      }
    : {}),
  defaultProvider: configuration.defaultProvider,
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
  },
});
