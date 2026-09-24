import Fastify from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
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
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '@college-library/config';
import { createMcpServer } from './mcp.js';
import { DatabaseLibrary } from './database-library.js';
import { ingestionManifestSchema } from '@college-library/contracts';

const app = Fastify({
  logger: true,
  bodyLimit: 25 * 1024 * 1024,
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
const oauthServiceUrl = config.OAUTH_SERVICE_URL.replace(/\/$/, '');
const oauthIssuer = publicBaseUrl;
const introspectToken = async (token: string) => {
  const response = await fetch(`${oauthServiceUrl}/internal/introspect`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-secret': config.OAUTH_INTERNAL_SECRET }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(3000) });
  if (!response.ok) return undefined;
  const result = await response.json() as { active?: boolean; email?: string; subscription_status?: string };
  return result.active ? result : undefined;
};
const requireSession = async (request: { headers: { authorization?: string } }, reply: { header: (name: string, value: string) => unknown; code: (statusCode: number) => { send: (payload: object) => unknown } }) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (token) {
    const session = await introspectToken(token);
    if (session?.subscription_status !== 'active') {
      reply.header('www-authenticate', 'Bearer error=\"insufficient_scope\"');
      reply.code(403).send({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Active subscription required', data: { subscription_url: `${publicBaseUrl}/#subscription` } } });
      return undefined;
    }
    if (session) return session;
  }
  reply.header('www-authenticate', `Bearer realm=\"${oauthIssuer}/mcp\", authorization_uri=\"${oauthIssuer}/oauth/authorize\"`);
  reply.code(401).send({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Authentication required' } });
  return undefined;
};
const downloadUrl = (documentIds: string[]) => {
  const expires = Math.floor(Date.now() / 1000) + 600;
  const ids = documentIds.join(',');
  const path = `/api/v1/documents/download?documentIds=${encodeURIComponent(ids)}`;
  return `${publicBaseUrl}${path}&expires=${expires}&signature=${signDownload(documentIds, expires)}`;
};
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

  const parsed = ingestionManifestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid_manifest', details: parsed.error.issues });
  }

  const manifest = parsed.data;
  const documentDir = join(config.LIBRARY_DATA_DIR, manifest.documentId);
  const stagingDir = join(config.LIBRARY_DATA_DIR, `.staging-${manifest.documentId}-${Date.now()}`);
  try {
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\\n`, 'utf8');
    await Promise.all(
      manifest.pages.map((page) =>
        writeFile(join(stagingDir, `page-${String(page.pageNumber).padStart(4, '0')}.md`), page.text, 'utf8'),
      ),
    );
    await rename(stagingDir, documentDir).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
      await rm(documentDir, { recursive: true, force: true });
      await rename(stagingDir, documentDir);
    });
    await library.syncFiles();
    return reply.code(201).send({ documentId: manifest.documentId, synced: true });
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    request.log.error(error, 'Failed to persist ingestion manifest');
    return reply.code(500).send({ error: 'manifest_persistence_failed' });
  }
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
  if (!(await requireSession(request, reply))) return;
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
