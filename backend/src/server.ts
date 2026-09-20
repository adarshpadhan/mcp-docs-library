import Fastify from 'fastify';
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { createRequire } from 'node:module';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Archiver } from 'archiver';

const require = createRequire(import.meta.url);
const fastifyVersion = (require('fastify/package.json') as { version: string })
  .version;
const archiverModule = require('archiver') as {
  default?: (format: string, options?: object) => Archiver;
  ZipArchive?: new (options?: object) => Archiver;
};
const archiver =
  archiverModule.default ??
  ((format: string, options?: object) => {
    if (format !== 'zip' || !archiverModule.ZipArchive) {
      throw new Error(`Unsupported archive format: ${format}`);
    }
    return new archiverModule.ZipArchive(options);
  });
import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '@college-library/config';
import { createMcpServer } from './mcp.js';
import { DatabaseLibrary } from './database-library.js';

const app = Fastify({
  logger: true,
  bodyLimit: 1_048_576,
  serverFactory: (() => {
    if (!config.HTTPS_CERT_FILE || !config.HTTPS_KEY_FILE) return undefined;
    const httpsOptions = {
      cert: readFileSync(config.HTTPS_CERT_FILE),
      key: readFileSync(config.HTTPS_KEY_FILE),
    };
    return (handler: Parameters<typeof createHttpsServer>[1]) =>
      createHttpsServer(httpsOptions, handler);
  })(),
});
app.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  },
);

type RateLimitBucket = { count: number; resetAt: number };
const rateLimitBuckets = new Map<string, RateLimitBucket>();
const rateLimitKey = (request: {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
  routeOptions: { url?: string };
}) => {
  const forwardedIp = request.headers['cf-connecting-ip'];
  const clientIp = Array.isArray(forwardedIp) ? forwardedIp[0] : forwardedIp;
  return `${clientIp || request.ip}:${request.routeOptions.url ?? 'unknown'}`;
};
const rateLimit = (
  request: {
    ip: string;
    headers: Record<string, string | string[] | undefined>;
    routeOptions: { url?: string };
  },
  reply: {
    header: (name: string, value: string) => unknown;
    code: (status: number) => { send: (payload: object) => unknown };
  },
  maxRequests: number,
) => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
  }
  const key = rateLimitKey(request);
  const bucket = rateLimitBuckets.get(key);
  const resetAt = bucket?.resetAt ?? now + config.RATE_LIMIT_WINDOW_MS;
  const count = (bucket?.count ?? 0) + 1;
  rateLimitBuckets.set(key, { count, resetAt });
  const remaining = Math.max(0, maxRequests - count);
  const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
  reply.header('x-ratelimit-limit', String(maxRequests));
  reply.header('x-ratelimit-remaining', String(remaining));
  reply.header('x-ratelimit-reset', String(Math.ceil(resetAt / 1000)));
  if (count > maxRequests) {
    reply.header('retry-after', String(retryAfter));
    reply
      .code(429)
      .send({ error: 'rate_limit_exceeded', retry_after: retryAfter });
    return false;
  }
  return true;
};
const rateLimitMaxForRoute = (url: string | undefined) => {
  if (url?.startsWith('/auth/')) return config.RATE_LIMIT_AUTH_MAX_REQUESTS;
  if (url?.startsWith('/oauth/')) return config.RATE_LIMIT_OAUTH_MAX_REQUESTS;
  if (url === '/mcp') return config.RATE_LIMIT_MCP_MAX_REQUESTS;
  return config.RATE_LIMIT_MAX_REQUESTS;
};
app.addHook('onRequest', async (request, reply) => {
  if (
    !rateLimit(request, reply, rateLimitMaxForRoute(request.routeOptions.url))
  )
    return;

  reply.removeHeader('server');
  reply.removeHeader('x-powered-by');
  reply.header('x-service-version', config.MCP_SERVER_VERSION);
  reply.header('x-framework', 'Fastify');
  reply.header('x-framework-version', fastifyVersion);
  const forwardedProto = request.headers['x-forwarded-proto'];
  const protocol = (
    Array.isArray(forwardedProto) ? forwardedProto[0] : (forwardedProto ?? '')
  )
    .split(',')[0]
    .trim()
    .toLowerCase();
  const isHttps = protocol === 'https' || request.protocol === 'https';
  if (isHttps) {
    reply.header(
      'strict-transport-security',
      'max-age=31536000; includeSubDomains',
    );
    return;
  }
  if (config.NODE_ENV === 'production') {
    const httpsUrl = `${publicBaseUrl}${request.url}`;
    return reply.code(308).redirect(httpsUrl);
  }
});
const library = new DatabaseLibrary(
  config.DATABASE_URL,
  config.LIBRARY_DATA_DIR,
  config.RAW_DATA_DIR,
  config.MCP_INCLUDE_PENDING,
  config.EMBEDDING_API_URL,
  config.EMBEDDING_API_KEY,
  config.EMBEDDING_MODEL,
);
const sessions = new Map<string, StreamableHTTPServerTransport>();
const signDownload = (documentIds: string[], expires: number) =>
  createHmac('sha256', config.DOWNLOAD_SIGNING_SECRET)
    .update(`${documentIds.join(',')}.${expires}`)
    .digest('hex');
const publicBaseUrl = config.PUBLIC_BASE_URL?.replace(/\/$/, '') ?? '';
const oauthConfigured = Boolean(
  config.GOOGLE_OAUTH_CLIENT_ID &&
  config.GOOGLE_OAUTH_CLIENT_SECRET &&
  config.GOOGLE_OAUTH_REDIRECT_URI &&
  config.AUTH_SESSION_SECRET,
);
const oauthState = new Map<string, number>();
type ClientMetadata = {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
};
const clientMetadataCache = new Map<
  string,
  { metadata: ClientMetadata; expiresAt: number }
>();
const isPrivateIp = (address: string) => {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return (
    version === 6 &&
    (address === '::1' ||
      address === '::' ||
      address.toLowerCase().startsWith('fc') ||
      address.toLowerCase().startsWith('fd') ||
      address.toLowerCase().startsWith('fe80:'))
  );
};
const fetchClientMetadata = async (
  clientId: string,
): Promise<ClientMetadata | undefined> => {
  if (!/^https:\/\//i.test(clientId)) return undefined;
  const cached = clientMetadataCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.metadata;
  const url = new URL(clientId);
  if (url.username || url.password || url.port) return undefined;
  const addresses = isIP(url.hostname)
    ? [url.hostname]
    : (await lookup(url.hostname, { all: true })).map(({ address }) => address);
  if (!addresses.length || addresses.some(isPrivateIp)) return undefined;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
    headers: { accept: 'application/json' },
  });
  if (
    !response.ok ||
    Number(response.headers.get('content-length') ?? 0) > 65_536
  )
    return undefined;
  const metadata = (await response.json()) as Partial<ClientMetadata>;
  if (
    metadata.client_id !== clientId ||
    !Array.isArray(metadata.redirect_uris) ||
    metadata.redirect_uris.length === 0 ||
    metadata.redirect_uris.length > 20 ||
    metadata.redirect_uris.some((uri) => typeof uri !== 'string')
  )
    return undefined;
  const normalized: ClientMetadata = {
    client_id: metadata.client_id,
    client_name: metadata.client_name,
    redirect_uris: metadata.redirect_uris,
    grant_types: metadata.grant_types,
    response_types: metadata.response_types,
    token_endpoint_auth_method: metadata.token_endpoint_auth_method,
  };
  clientMetadataCache.set(clientId, {
    metadata: normalized,
    expiresAt: Date.now() + 5 * 60_000,
  });
  return normalized;
};
const isRedirectUriAllowed = (
  requestedUri: string,
  registeredUris: string[],
) => {
  if (registeredUris.includes(requestedUri)) return true;
  try {
    const requested = new URL(requestedUri);
    if (
      requested.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(requested.hostname) ||
      requested.username ||
      requested.password ||
      requested.search ||
      requested.hash
    )
      return false;
    return registeredUris.some((registeredUri) => {
      const registered = new URL(registeredUri);
      return (
        registered.protocol === 'http:' &&
        registered.hostname === requested.hostname &&
        registered.pathname === requested.pathname &&
        !registered.port
      );
    });
  } catch {
    return false;
  }
};
const mcpOAuthRequests = new Map<
  string,
  {
    clientId: string;
    redirectUri: string;
    state?: string;
    codeChallenge: string;
    expiresAt: number;
  }
>();
const mcpOAuthCodes = new Map<
  string,
  {
    clientId: string;
    redirectUri: string;
    email: string;
    codeChallenge: string;
    expiresAt: number;
  }
>();
const mcpAccessTokens = new Map<
  string,
  { clientId: string; email: string; expiresAt: number }
>();
const parseCookies = (header = '') =>
  Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split('=').map(decodeURIComponent))
      .filter(([key, value]) => key && value),
  );
const sessionCookie = (value: string) =>
  `library_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${config.NODE_ENV === 'production' ? '; Secure' : ''}`;
const clearSessionCookie = `library_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${config.NODE_ENV === 'production' ? '; Secure' : ''}`;
const signSession = (payload: string) =>
  `${payload}.${createHmac('sha256', config.AUTH_SESSION_SECRET!).update(payload).digest('base64url')}`;
const verifySession = (value?: string) => {
  if (!value || !config.AUTH_SESSION_SECRET) return undefined;
  const [payload, signature] = value.split('.');
  const expected = payload
    ? createHmac('sha256', config.AUTH_SESSION_SECRET)
        .update(payload)
        .digest('base64url')
    : '';
  if (
    !signature ||
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    return undefined;
  try {
    const session = JSON.parse(
      Buffer.from(payload, 'base64url').toString(),
    ) as { email?: string; name?: string; exp?: number };
    return session.exp && session.exp > Math.floor(Date.now() / 1000)
      ? session
      : undefined;
  } catch {
    return undefined;
  }
};
const adminBearerSession = (request: {
  headers: { authorization?: string };
}) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token || token.length !== config.ADMIN_INGEST_TOKEN.length)
    return undefined;
  if (
    !timingSafeEqual(Buffer.from(token), Buffer.from(config.ADMIN_INGEST_TOKEN))
  )
    return undefined;
  return { email: 'admin@college-library.local', name: 'MCP administrator' };
};
const requireSession = (
  request: { headers: { authorization?: string; cookie?: string } },
  reply: {
    code: (statusCode: number) => { send: (payload: object) => unknown };
  },
) => {
  const bearer = bearerSession(request);
  if (bearer) return bearer;
  const admin = adminBearerSession(request);
  if (admin) return admin;
  if (!oauthConfigured) {
    if (config.NODE_ENV === 'production') {
      reply.code(503).send({ error: 'google_oauth_not_configured' });
      return undefined;
    }
    return { email: 'development@localhost' };
  }
  const session = verifySession(
    parseCookies(request.headers.cookie).library_session,
  );
  if (!session) {
    reply.code(401).send({ error: 'authentication_required' });
    return undefined;
  }
  return session;
};
const downloadUrl = (documentIds: string[]) => {
  const expires = Math.floor(Date.now() / 1000) + 600;
  const ids = documentIds.join(',');
  const path = `/api/v1/documents/download?documentIds=${encodeURIComponent(ids)}`;
  return `${publicBaseUrl}${path}&expires=${expires}&signature=${signDownload(documentIds, expires)}`;
};
const oauthIssuer = publicBaseUrl;
const mcpSupportedVersions = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];
const mcpDiscovery = {
  supportedVersions: mcpSupportedVersions,
  capabilities: {
    tools: {},
    resources: {},
  },
  instructions:
    'Use search_library and semantic_search to find published college-library content. Use get_document_text for exact OCR text and create_document_download_link for original PDFs or ZIP archives.',
  resultType: 'complete',
  ttlMs: 300_000,
  cacheScope: 'public',
};
const oauthMetadata = {
  issuer: oauthIssuer,
  authorization_endpoint: `${oauthIssuer}/oauth/authorize`,
  token_endpoint: `${oauthIssuer}/oauth/token`,
  registration_endpoint: `${oauthIssuer}/oauth/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code'],
  code_challenge_methods_supported: ['S256'],
  authorization_response_iss_parameter_supported: true,
  client_id_metadata_document_supported: true,
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: ['openid', 'email', 'profile'],
};
const bearerSession = (request: {
  headers: { authorization?: string; cookie?: string };
}) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return undefined;
  const session = mcpAccessTokens.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) mcpAccessTokens.delete(token);
    return undefined;
  }
  return session;
};

app.get('/auth/google', async (_request, reply) => {
  if (!oauthConfigured)
    return reply.code(503).send({ error: 'google_oauth_not_configured' });
  const state = randomBytes(32).toString('base64url');
  oauthState.set(state, Date.now() + 10 * 60 * 1000);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.GOOGLE_OAUTH_CLIENT_ID!);
  url.searchParams.set('redirect_uri', config.GOOGLE_OAUTH_REDIRECT_URI!);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('hd', config.COLLEGE_DOMAIN);
  url.searchParams.set('prompt', 'select_account');
  return reply.redirect(url.toString());
});

app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
  '/auth/google/callback',
  async (request, reply) => {
    const { code, state, error } = request.query;
    if (error) return reply.code(400).send({ error: 'google_oauth_denied' });
    const expiresAt = state ? oauthState.get(state) : undefined;
    const mcpRequest = state ? mcpOAuthRequests.get(state) : undefined;
    oauthState.delete(state ?? '');
    if (mcpRequest) mcpOAuthRequests.delete(state!);
    if (!code || !state || !expiresAt || expiresAt < Date.now())
      return reply.code(400).send({ error: 'invalid_oauth_state' });
    if (!oauthConfigured)
      return reply.code(503).send({ error: 'google_oauth_not_configured' });

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.GOOGLE_OAUTH_CLIENT_ID!,
        client_secret: config.GOOGLE_OAUTH_CLIENT_SECRET!,
        redirect_uri: config.GOOGLE_OAUTH_REDIRECT_URI!,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenResponse.ok)
      return reply.code(401).send({ error: 'google_token_exchange_failed' });
    const tokens = (await tokenResponse.json()) as { access_token?: string };
    if (!tokens.access_token)
      return reply.code(401).send({ error: 'google_access_token_missing' });
    const profileResponse = await fetch(
      'https://openidconnect.googleapis.com/v1/userinfo',
      { headers: { authorization: `Bearer ${tokens.access_token}` } },
    );
    if (!profileResponse.ok)
      return reply.code(401).send({ error: 'google_profile_fetch_failed' });
    const profile = (await profileResponse.json()) as {
      email?: string;
      name?: string;
      email_verified?: boolean;
      hd?: string;
    };
    const emailDomain = profile.email?.split('@')[1]?.toLowerCase();
    if (
      !profile.email ||
      !profile.email_verified ||
      emailDomain !== config.COLLEGE_DOMAIN.toLowerCase() ||
      (profile.hd &&
        profile.hd.toLowerCase() !== config.COLLEGE_DOMAIN.toLowerCase())
    ) {
      return reply.code(403).send({ error: 'college_domain_required' });
    }
    if (mcpRequest) {
      const authorizationCode = randomBytes(32).toString('base64url');
      mcpOAuthCodes.set(authorizationCode, {
        clientId: mcpRequest.clientId,
        redirectUri: mcpRequest.redirectUri,
        email: profile.email,
        codeChallenge: mcpRequest.codeChallenge,
        expiresAt: Date.now() + 60_000,
      });
      const redirect = new URL(mcpRequest.redirectUri);
      redirect.searchParams.set('code', authorizationCode);
      if (mcpRequest.state)
        redirect.searchParams.set('state', mcpRequest.state);
      // RFC 9207: identify the authorization server in every authorization response.
      redirect.searchParams.set('iss', oauthIssuer);
      return reply.redirect(redirect.toString());
    }
    const payload = Buffer.from(
      JSON.stringify({
        email: profile.email,
        name: profile.name,
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      }),
    ).toString('base64url');
    return reply
      .header('set-cookie', sessionCookie(signSession(payload)))
      .redirect('/');
  },
);

app.get('/.well-known/oauth-authorization-server', async (_request, reply) => {
  if (!oauthConfigured)
    return reply.code(503).send({ error: 'google_oauth_not_configured' });
  return oauthMetadata;
});

const protectedResourceMetadata = {
  resource: `${oauthIssuer}/mcp`,
  authorization_servers: [oauthIssuer],
  scopes_supported: ['openid', 'email', 'profile'],
};
app.get(
  '/.well-known/oauth-protected-resource',
  async () => protectedResourceMetadata,
);
app.get(
  '/.well-known/oauth-protected-resource/mcp',
  async () => protectedResourceMetadata,
);

app.get<{ Querystring: Record<string, string | undefined> }>(
  '/oauth/authorize',
  async (request, reply) => {
    if (!oauthConfigured)
      return reply.code(503).send({ error: 'google_oauth_not_configured' });
    const {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: responseType,
      state,
      code_challenge: codeChallenge,
    } = request.query;
    if (
      !clientId ||
      responseType !== 'code' ||
      !redirectUri ||
      !/^https?:\/\//.test(redirectUri) ||
      !codeChallenge
    ) {
      return reply.code(400).send({ error: 'invalid_authorization_request' });
    }
    let clientMetadata: ClientMetadata | undefined;
    try {
      clientMetadata = await fetchClientMetadata(clientId);
    } catch {
      return reply.code(400).send({ error: 'invalid_client' });
    }
    if (
      clientId.startsWith('https://') &&
      (!clientMetadata ||
        !isRedirectUriAllowed(redirectUri, clientMetadata.redirect_uris))
    ) {
      return reply.code(400).send({ error: 'invalid_client' });
    }
    const oauthStateValue = randomBytes(32).toString('base64url');
    mcpOAuthRequests.set(oauthStateValue, {
      clientId,
      redirectUri,
      state,
      codeChallenge,
      expiresAt: Date.now() + 10 * 60_000,
    });
    oauthState.set(oauthStateValue, Date.now() + 10 * 60_000);
    const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    googleUrl.searchParams.set('client_id', config.GOOGLE_OAUTH_CLIENT_ID!);
    googleUrl.searchParams.set(
      'redirect_uri',
      config.GOOGLE_OAUTH_REDIRECT_URI!,
    );
    googleUrl.searchParams.set('response_type', 'code');
    googleUrl.searchParams.set('scope', 'openid email profile');
    googleUrl.searchParams.set('state', oauthStateValue);
    googleUrl.searchParams.set('hd', config.COLLEGE_DOMAIN);
    googleUrl.searchParams.set('prompt', 'select_account');
    return reply.redirect(googleUrl.toString());
  },
);

app.post<{ Body: Record<string, unknown> }>(
  '/oauth/token',
  async (request, reply) => {
    const body = request.body ?? {};
    const code = typeof body.code === 'string' ? body.code : '';
    const clientId = typeof body.client_id === 'string' ? body.client_id : '';
    const redirectUri =
      typeof body.redirect_uri === 'string' ? body.redirect_uri : '';
    const codeVerifier =
      typeof body.code_verifier === 'string' ? body.code_verifier : '';
    let clientMetadata: ClientMetadata | undefined;
    if (clientId.startsWith('https://')) {
      try {
        clientMetadata = await fetchClientMetadata(clientId);
      } catch {
        return reply.code(400).send({ error: 'invalid_client' });
      }
    }
    const authorization = mcpOAuthCodes.get(code);
    if (
      clientMetadata &&
      !isRedirectUriAllowed(redirectUri, clientMetadata.redirect_uris)
    ) {
      return reply.code(400).send({ error: 'invalid_client' });
    }
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    if (
      !authorization ||
      authorization.expiresAt <= Date.now() ||
      authorization.clientId !== clientId ||
      authorization.redirectUri !== redirectUri ||
      authorization.codeChallenge !== codeChallenge
    ) {
      return reply.code(400).send({ error: 'invalid_grant' });
    }
    mcpOAuthCodes.delete(code);
    const expiresAt = Date.now() + 3600_000;
    const accessToken = randomBytes(32).toString('base64url');
    mcpAccessTokens.set(accessToken, {
      clientId,
      email: authorization.email,
      expiresAt,
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid email profile',
    };
  },
);

app.post<{ Body: { client_name?: string; redirect_uris?: string[] } }>(
  '/oauth/register',
  async (request) => ({
    client_id: `mcp-${randomBytes(16).toString('hex')}`,
    client_name: request.body?.client_name ?? 'MCP client',
    redirect_uris: request.body?.redirect_uris ?? [],
    token_endpoint_auth_method: 'none',
  }),
);

app.get('/auth/me', async (request, reply) => {
  const session = verifySession(
    parseCookies(request.headers.cookie).library_session,
  );
  if (!session) return reply.code(401).send({ error: 'unauthorized' });
  return session;
});

app.post('/auth/logout', async (_request, reply) =>
  reply.header('set-cookie', clearSessionCookie).send({ ok: true }),
);

app.get('/', async () => ({
  service: config.MCP_SERVER_NAME,
  login: '/auth/google',
  session: '/auth/me',
}));

app.get('/health', async () => ({
  status: 'ok',
  service: config.MCP_SERVER_NAME,
  version: config.MCP_SERVER_VERSION,
}));

app.get('/api/v1/ingestion/jobs', async () => ({
  jobs: [],
  message: 'Ingestion queue is ready for database integration.',
}));

app.post('/api/v1/ingestion/manifests', async (request, reply) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (token !== config.ADMIN_INGEST_TOKEN) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  return reply
    .code(501)
    .send({ error: 'manifest_persistence_not_implemented' });
});

app.get<{
  Querystring: { documentIds: string; expires?: string; signature?: string };
}>('/api/v1/documents/download', async (request, reply) => {
  const documentIds = request.query.documentIds.split(',').filter(Boolean);
  const expires = Number(request.query.expires);
  const expected =
    request.query.signature && Number.isSafeInteger(expires)
      ? signDownload(documentIds, expires)
      : '';
  const signed =
    request.query.signature &&
    expected &&
    Buffer.byteLength(request.query.signature) ===
      Buffer.byteLength(expected) &&
    timingSafeEqual(
      Buffer.from(request.query.signature),
      Buffer.from(expected),
    );
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (
    !documentIds.length ||
    documentIds.length > 20 ||
    (token !== config.ADMIN_INGEST_TOKEN &&
      (!signed || expires < Math.floor(Date.now() / 1000)))
  ) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const documents = await Promise.all(documentIds.map((id) => library.raw(id)));
  if (documents.some((document) => !document))
    return reply.code(404).send({ error: 'document_not_found' });
  reply.hijack();
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (error: Error) => reply.raw.destroy(error));
  reply.raw.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition':
      'attachment; filename="college-library-documents.zip"',
  });
  archive.pipe(reply.raw);
  for (const document of documents) {
    if (document) archive.file(document.path, { name: document.filename });
  }
  await archive.finalize();
});

app.get<{
  Params: { documentId: string };
  Querystring: { expires?: string; signature?: string };
}>('/api/v1/documents/:documentId/file', async (request, reply) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  const expires = Number(request.query.expires);
  const expected =
    request.query.signature && Number.isSafeInteger(expires)
      ? signDownload([request.params.documentId], expires)
      : '';
  const signed =
    request.query.signature &&
    expected &&
    Buffer.byteLength(request.query.signature) ===
      Buffer.byteLength(expected) &&
    timingSafeEqual(
      Buffer.from(request.query.signature),
      Buffer.from(expected),
    );
  if (
    token !== config.ADMIN_INGEST_TOKEN &&
    (!signed || expires < Math.floor(Date.now() / 1000))
  ) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const document = await library.raw(request.params.documentId);
  if (!document) return reply.code(404).send({ error: 'document_not_found' });
  const data = await import('node:fs/promises').then(({ readFile }) =>
    readFile(document.path),
  );
  return reply
    .type('application/pdf')
    .header(
      'content-disposition',
      `attachment; filename="${document.filename.replace(/"/g, '')}"`,
    )
    .send(data);
});

const mcpMethodsRequiringRoutingHeader = new Set([
  'initialize',
  'notifications/initialized',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'resources/subscribe',
  'resources/unsubscribe',
  'prompts/list',
  'prompts/get',
  'completion/complete',
  'server/discover',
]);
app.all('/mcp', async (request, reply) => {
  const body = request.body as { method?: string } | undefined;
  const mcpMethodHeader = request.headers['mcp-method'];
  const mcpMethod = Array.isArray(mcpMethodHeader)
    ? mcpMethodHeader[0]
    : mcpMethodHeader;
  if (
    request.method === 'POST' &&
    body?.method &&
    mcpMethod &&
    mcpMethodsRequiringRoutingHeader.has(body.method) &&
    mcpMethod !== body.method
  ) {
    return reply.code(400).send({
      jsonrpc: '2.0',
      id:
        body && 'id' in body
          ? ((body as { id?: string | number | null }).id ?? null)
          : null,
      error: {
        code: -32600,
        message: 'Mcp-Method header does not match the JSON-RPC method',
      },
    });
  }
  if (request.method === 'POST' && body?.method === 'server/discover') {
    return reply.send({
      jsonrpc: '2.0',
      id: (request.body as { id?: string | number | null }).id ?? null,
      result: mcpDiscovery,
    });
  }
  if (!requireSession(request, reply)) return;
  const sessionId = request.headers['mcp-session-id'];
  let transport =
    typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
  const stateless = !transport && request.method === 'POST';

  if (!transport && !stateless) {
    request.log.warn(
      {
        method: request.method,
        mcpMethod,
        hasSessionId: Boolean(sessionId),
        hasBearer: Boolean(request.headers.authorization),
      },
      'MCP request rejected because no transport session was found',
    );
    return reply.code(400).send({ error: 'mcp_session_required' });
  }

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = createMcpServer(
      config.MCP_SERVER_NAME,
      config.MCP_SERVER_VERSION,
      library,
      downloadUrl,
    );
    transport.onclose = () => {
      if (transport?.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
  }

  reply.hijack();
  await transport.handleRequest(request.raw, reply.raw, request.body);
  if (transport.sessionId) sessions.set(transport.sessionId, transport);
});

async function start(): Promise<void> {
  await library.syncFiles();
  await app.listen({ host: config.HOST, port: config.PORT });
  app.log.info(
    `API listening on ${config.HTTPS_CERT_FILE ? 'https' : 'http'}://${config.HOST}:${config.PORT}`,
  );
  app.log.info('MCP Streamable HTTP endpoint available at /mcp');
}

start().catch((error: unknown) => {
  app.log.error(error);
  process.exitCode = 1;
});
