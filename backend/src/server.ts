import Fastify from 'fastify';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Archiver } from 'archiver';

const require = createRequire(import.meta.url);
const archiverModule = require('archiver') as {
  default?: (format: string, options?: object) => Archiver;
  ZipArchive?: new (options?: object) => Archiver;
};
const archiver = archiverModule.default
  ?? ((format: string, options?: object) => {
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
const signDownload = (documentIds: string[], expires: number) => createHmac('sha256', config.DOWNLOAD_SIGNING_SECRET).update(`${documentIds.join(',')}.${expires}`).digest('hex');
const publicBaseUrl = config.PUBLIC_BASE_URL?.replace(/\/$/, '') ?? '';
const downloadUrl = (documentIds: string[]) => {
  const expires = Math.floor(Date.now() / 1000) + 600;
  const ids = documentIds.join(',');
  const path = `/api/v1/documents/download?documentIds=${encodeURIComponent(ids)}`;
  return `${publicBaseUrl}${path}&expires=${expires}&signature=${signDownload(documentIds, expires)}`;
};

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
  return reply.code(501).send({ error: 'manifest_persistence_not_implemented' });
});

app.get<{ Querystring: { documentIds: string; expires?: string; signature?: string } }>('/api/v1/documents/download', async (request, reply) => {
  const documentIds = request.query.documentIds.split(',').filter(Boolean);
  const expires = Number(request.query.expires);
  const expected = request.query.signature && Number.isSafeInteger(expires) ? signDownload(documentIds, expires) : '';
  const signed = request.query.signature && expected && Buffer.byteLength(request.query.signature) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(request.query.signature), Buffer.from(expected));
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!documentIds.length || documentIds.length > 20 || (token !== config.ADMIN_INGEST_TOKEN && (!signed || expires < Math.floor(Date.now() / 1000)))) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const documents = await Promise.all(documentIds.map((id) => library.raw(id)));
  if (documents.some((document) => !document)) return reply.code(404).send({ error: 'document_not_found' });
  reply.hijack();
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (error: Error) => reply.raw.destroy(error));
  reply.raw.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': 'attachment; filename="college-library-documents.zip"',
  });
  archive.pipe(reply.raw);
  for (const document of documents) {
    if (document) archive.file(document.path, { name: document.filename });
  }
  await archive.finalize();
});

app.get<{ Params: { documentId: string }; Querystring: { expires?: string; signature?: string } }>('/api/v1/documents/:documentId/file', async (request, reply) => {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  const expires = Number(request.query.expires);
  const expected = request.query.signature && Number.isSafeInteger(expires)
    ? signDownload([request.params.documentId], expires)
    : '';
  const signed = request.query.signature && expected && Buffer.byteLength(request.query.signature) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(request.query.signature), Buffer.from(expected));
  if (token !== config.ADMIN_INGEST_TOKEN && (!signed || expires < Math.floor(Date.now() / 1000))) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const document = await library.raw(request.params.documentId);
  if (!document) return reply.code(404).send({ error: 'document_not_found' });
  const data = await import('node:fs/promises').then(({ readFile }) => readFile(document.path));
  return reply
    .type('application/pdf')
    .header('content-disposition', `attachment; filename="${document.filename.replace(/"/g, '')}"`)
    .send(data);
});

app.all('/mcp', async (request, reply) => {
  const sessionId = request.headers['mcp-session-id'];
  let transport = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
  const stateless = !transport && request.method === 'POST';

  if (!transport && !stateless) {
    return reply.code(400).send({ error: 'mcp_session_required' });
  }

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      ...(request.body as { method?: string } | undefined)?.method === 'initialize'
        ? { sessionIdGenerator: () => randomUUID() }
        : {},
    });
    const server = createMcpServer(config.MCP_SERVER_NAME, config.MCP_SERVER_VERSION, library, downloadUrl);
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
