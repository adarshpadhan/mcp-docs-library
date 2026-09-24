import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ingestionManifestSchema } from '@college-library/contracts';

const [packageDir, backendUrl = process.env.BACKEND_URL ?? 'http://127.0.0.1:8787'] = process.argv.slice(2);
const token = process.env.ADMIN_INGEST_TOKEN;
if (!packageDir || !token) {
  console.error('Usage: ADMIN_INGEST_TOKEN=... npm run publish:ingest -- /path/to/package [backend-url]');
  process.exit(1);
}
const manifest = ingestionManifestSchema.parse(JSON.parse(await readFile(join(resolve(packageDir), 'manifest.json'), 'utf8')));
const response = await fetch(`${backendUrl.replace(/\/$/, '')}/api/v1/ingestion/manifests`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(manifest),
});
const body = await response.text();
if (!response.ok) throw new Error(`Backend rejected manifest (${response.status}): ${body}`);
console.log(body);
