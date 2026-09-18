import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ingestionManifestSchema,
  type IngestionManifest,
} from '@college-library/contracts';

export type LibraryDocument = IngestionManifest & { pagesText: string };

export class FileLibrary {
  private documents: LibraryDocument[] | undefined;

  constructor(
    private readonly rootDir: string,
    private readonly includePending: boolean,
  ) {}

  private async load(): Promise<LibraryDocument[]> {
    if (this.documents) return this.documents;

    const entries = await readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const documents: LibraryDocument[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = ingestionManifestSchema.parse(
          JSON.parse(await readFile(join(this.rootDir, entry.name, 'manifest.json'), 'utf8')),
        );
        if (!this.includePending && manifest.metadata.licenseStatus !== 'verified') continue;
        documents.push({
          ...manifest,
          pagesText: manifest.pages.map((page) => page.text).join('\n\n'),
        });
      } catch {
        // Ignore incomplete or invalid work-in-progress packages.
      }
    }
    this.documents = documents;
    return documents;
  }

  async search(query: string, filters: { courseCode?: string; documentType?: string }, limit: number) {
    const normalizedQuery = query.toLowerCase();
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    const documents = await this.load();
    return documents
      .filter((document) => !filters.courseCode || document.metadata.courseCode === filters.courseCode)
      .filter((document) => !filters.documentType || document.metadata.documentType === filters.documentType)
      .map((document) => {
        const haystack = [
          document.metadata.title,
          document.metadata.subject,
          document.metadata.courseCode,
          document.pagesText,
        ].join(' ').toLowerCase();
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return { document, score };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ document, score }) => ({
        documentId: document.documentId,
        title: document.metadata.title,
        subject: document.metadata.subject,
        courseCode: document.metadata.courseCode,
        documentType: document.metadata.documentType,
        licenseStatus: document.metadata.licenseStatus,
        score,
        citations: document.pages.map((page) => ({
          pageNumber: page.pageNumber,
          excerpt: page.text.slice(0, 500),
        })),
      }));
  }

  async retrieve(question: string, courseCode: string | undefined, tokenBudget: number) {
    const documents = await this.load();
    const results = await this.search(question, { courseCode }, documents.length);
    const passages: Array<{ documentId: string; title: string; pageNumber: number; text: string }> = [];
    let used = 0;
    for (const result of results) {
      const document = documents.find((item) => item.documentId === result.documentId);
      if (!document) continue;
      for (const page of document.pages) {
        const remaining = tokenBudget * 4 - used;
        if (remaining <= 0) return passages;
        const text = page.text.slice(0, remaining);
        passages.push({ documentId: document.documentId, title: document.metadata.title, pageNumber: page.pageNumber, text });
        used += text.length;
      }
    }
    return passages;
  }

  async subjects() {
    const documents = await this.load();
    return [...new Set(documents.map((document) => document.metadata.subject))].sort();
  }
}
