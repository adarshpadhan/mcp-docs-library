import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { ingestionManifestSchema } from '@college-library/contracts';
import { processPdfWithUnlimitedOcr } from './unlimited-ocr.js';

const [inputPath, mode = 'contract', ...metadataArgs] = process.argv.slice(2);

if (!inputPath) {
  console.error('Usage: npm run dev:ingest -- /path/to/document.pdf');
  process.exit(1);
}

if (mode === 'unlimited-ocr') {
  if (!inputPath.toLowerCase().endsWith('.pdf')) {
    throw new Error('Unlimited-OCR mode currently requires a PDF input.');
  }
  const metadata = Object.fromEntries(
    metadataArgs
      .filter((argument) => argument.includes('='))
      .map((argument) => argument.split('=', 2)),
  );
  const manifest = await processPdfWithUnlimitedOcr(inputPath, metadata);
  const outputDir = resolve('local-ingest', 'data', 'processed', manifest.documentId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await Promise.all(
    manifest.pages.map((page) =>
      writeFile(join(outputDir, `page-${String(page.pageNumber).padStart(4, '0')}.md`), page.text),
    ),
  );
  console.log(JSON.stringify({ ...manifest, outputDir }, null, 2));
  process.exit(0);
}

const bytes = await readFile(inputPath);
const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
const documentId = crypto.randomUUID();

const manifest = ingestionManifestSchema.parse({
  documentId,
  sourceSha256,
  ocrEngine: 'UnlimitedOCR',
  ocrVersion: 'configure-before-first-run',
  parserVersion: '0.1.0',
  language: 'en',
  processedAt: new Date().toISOString(),
  pages: [],
  metadata: {
    title: basename(inputPath),
    filename: basename(inputPath),
    mimeType: 'application/pdf',
    documentType: 'pyq',
    courseCode: 'UNKNOWN',
    subject: 'Unknown',
    semester: 'Unknown',
    examYear: 'Unknown',
    language: 'en',
    contributor: 'Unknown',
    rawLicense: {
      identifier: 'PENDING_REVIEW',
      name: 'License pending administrator review',
      attribution: 'Pending administrator review',
    },
    processedLicense: {
      identifier: 'PENDING_REVIEW',
      name: 'License pending administrator review',
      attribution: 'Pending administrator review',
    },
    licenseStatus: 'pending_review',
    rightsNotes: 'Do not publish until an administrator verifies redistribution rights.',
  },
});

console.log(JSON.stringify(manifest, null, 2));
