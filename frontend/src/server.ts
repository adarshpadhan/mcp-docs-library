import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const app = Fastify({ logger: true });
app.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  },
);
const backend = process.env.BACKEND_URL ?? 'http://backend:8787';

const proxyTo = async (request: {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}, target: string, reply: {
  code: (code: number) => {
    header: (name: string, value: string) => unknown;
    send: (body: string) => unknown;
  };
}) => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value && !['host', 'content-length'].includes(key))
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const requestContentType = request.headers['content-type'];
  const requestBody =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : typeof request.body === 'string'
        ? request.body
        : (Array.isArray(requestContentType) ? requestContentType[0] : requestContentType)?.includes('application/json')
          ? JSON.stringify(request.body ?? {})
          : (Array.isArray(requestContentType) ? requestContentType[0] : requestContentType)?.includes('application/x-www-form-urlencoded')
            ? new URLSearchParams(request.body as Record<string, string>).toString()
            : request.body == null
              ? undefined
              : String(request.body);
  const response = await fetch(`${target}${request.url}`, {
    method: request.method,
    redirect: 'manual',
    headers,
    body: requestBody,
  });
  const body = await response.text();
  const result = reply.code(response.status);
  const contentType = response.headers.get('content-type');
  const setCookie = response.headers.get('set-cookie');
  const location = response.headers.get('location');
  const wwwAuthenticate = response.headers.get('www-authenticate');
  if (contentType) result.header('content-type', contentType);
  if (setCookie) result.header('set-cookie', setCookie);
  if (location) result.header('location', location);
  if (wwwAuthenticate) result.header('www-authenticate', wwwAuthenticate);
  return result.send(body);
};

app.all('/auth/*', async (request, reply) => proxyTo(request, process.env.OAUTH_URL ?? 'http://oauth:3001', reply));
app.all('/oauth/*', async (request, reply) => proxyTo(request, process.env.OAUTH_URL ?? 'http://oauth:3001', reply));
app.all('/.well-known/*', async (request, reply) => proxyTo(request, process.env.OAUTH_URL ?? 'http://oauth:3001', reply));
app.all('/api/subscription', async (request, reply) => proxyTo(request, process.env.OAUTH_URL ?? 'http://oauth:3001', reply));
app.all('/api/*', async (request, reply) => proxyTo(request, backend, reply));
app.all('/mcp', async (request, reply) => proxyTo(request, backend, reply));
app.get('/health', async (request, reply) => proxyTo(request, backend, reply));
app.get('/', async (_request, reply) => {
  reply.type('text/html').send(await readFile(join(process.cwd(), 'frontend/public/index.html'), 'utf8'));
});

app.listen({ host: '0.0.0.0', port: 3000 }).catch((error) => {
  app.log.error(error);
  process.exitCode = 1;
});
