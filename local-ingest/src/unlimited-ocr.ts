import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { ingestionManifestSchema, type IngestionManifest } from '@college-library/contracts';

const repositoryRoot = resolve(fileURLToPath(new URL('../vendor/unlimited-ocr-mac', import.meta.url)));
const runScript = join(repositoryRoot, 'run_mac.py');
const pythonBin = join(repositoryRoot, '.venv-ocr', 'bin', 'python');
const macAdapterCommit = 'fde21a9b84c1a80cff94cb8054d0172fdb679f57';

async function pdfToImages(inputPath: string, imageDir: string): Promise<void> {
  await mkdir(imageDir, { recursive: true });
  await new Promise<void>((resolvePromise, reject) => {
    const childProcess = spawn(
      pythonBin,
      [
        '-c',
        [
          'import pymupdf, os, sys',
          'doc = pymupdf.open(sys.argv[1])',
          'out = sys.argv[2]',
          'for i, page in enumerate(doc):',
          '    page.get_pixmap(matrix=pymupdf.Matrix(2, 2)).save(os.path.join(out, f"page_{i + 1:04d}.png"))',
          'doc.close()',
        ].join('\n'),
        inputPath,
        imageDir,
      ],
      { stdio: 'inherit' },
    );
    childProcess.once('error', reject);
    childProcess.once('exit', (code: number | null) =>
      code === 0 ? resolvePromise() : reject(new Error(`PDF conversion exited with code ${code ?? 'unknown'}`)),
    );
  });
}

function runInference(imageDir: string, outputDir: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const childProcess = spawn(
      pythonBin,
      [runScript, '--image_dir', imageDir, '--output_dir', outputDir],
      { stdio: 'inherit' },
    );

    childProcess.once('error', (error: Error) => {
      reject(new Error(`Unable to start Unlimited-OCR. Install its Python runtime: ${error.message}`));
    });
    childProcess.once('exit', (code: number | null) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `Unlimited-OCR Mac exited with code ${code ?? 'unknown'}. Check the local model installation and MPS runtime.`,
        ),
      );
    });
  });
}

function inferMetadataFromOcr(text: string): Record<string, string> {
  const courseCode = text.match(/Code\s*:-\s*([A-Z]{2,}-\d{3,})/i)?.[1];
  const semester = text.match(/Semester:\s*(\d+)/i)?.[1];
  const examYear = text.match(/EXAMINATION\s*-\s*(\d{4})/i)?.[1];
  const subject = text.match(/Data Mining and Data Warehousing/i)?.[0];
  return {
    ...(courseCode ? { courseCode } : {}),
    ...(semester ? { semester } : {}),
    ...(examYear ? { examYear } : {}),
    ...(subject ? { subject } : {}),
  };
}

export async function processPdfWithUnlimitedOcr(
  inputPath: string,
  metadata: Record<string, string> = {},
): Promise<IngestionManifest> {
  const absoluteInput = resolve(inputPath);
  const source = await readFile(absoluteInput);
  const sourceSha256 = createHash('sha256').update(source).digest('hex');
  const workDir = await mkdtemp(join(tmpdir(), 'college-library-ocr-'));
  const imageDir = join(workDir, 'images');
  const outputDir = join(workDir, 'output');

  try {
    await pdfToImages(absoluteInput, imageDir);
    await runInference(imageDir, outputDir);
    const outputFiles = (await readdir(outputDir))
      .filter((file) => file.endsWith('.md'))
      .sort();

    if (outputFiles.length === 0) {
      throw new Error('Unlimited-OCR completed without producing page Markdown output.');
    }

    const pages = await Promise.all(
      outputFiles.map(async (file, index) => ({
        pageNumber: index + 1,
        text: await readFile(join(outputDir, file), 'utf8'),
      })),
    );

    const inferredMetadata = inferMetadataFromOcr(pages.map((page) => page.text).join('\n'));
    const documentId = randomUUID();
    return ingestionManifestSchema.parse({
      documentId,
      sourceSha256,
      ocrEngine: 'UnlimitedOCR',
      ocrVersion: macAdapterCommit,
      parserVersion: '0.1.0',
      language: process.env.OCR_LANGUAGE ?? 'en',
      processedAt: new Date().toISOString(),
      pages,
      metadata: {
        title: metadata.title ?? basename(absoluteInput, '.pdf'),
        filename: basename(absoluteInput),
        mimeType: 'application/pdf',
        documentType: 'pyq',
        courseCode: metadata.courseCode ?? inferredMetadata.courseCode ?? 'UNKNOWN',
        subject: metadata.subject ?? inferredMetadata.subject ?? 'Unknown',
        semester: metadata.semester ?? inferredMetadata.semester ?? 'Unknown',
        examYear: metadata.examYear ?? inferredMetadata.examYear ?? 'Unknown',
        language: process.env.OCR_LANGUAGE ?? 'en',
        contributor: metadata.contributor ?? 'Unknown',
        sourceUrl: metadata.sourceUrl,
        rawLicense: {
          identifier: metadata.rawLicense ?? 'PENDING_REVIEW',
          name: metadata.rawLicenseName ?? 'License pending administrator review',
          attribution: metadata.attribution ?? 'Pending administrator review',
          url: metadata.rawLicenseUrl,
        },
        processedLicense: {
          identifier: metadata.processedLicense ?? 'PENDING_REVIEW',
          name: metadata.processedLicenseName ?? 'License pending administrator review',
          attribution: metadata.attribution ?? 'Pending administrator review',
          url: metadata.processedLicenseUrl,
        },
        licenseStatus: 'pending_review',
        rightsNotes: metadata.rightsNotes ?? 'Do not publish until an administrator verifies redistribution rights.',
      },
    });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
