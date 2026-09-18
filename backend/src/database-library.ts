import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { ingestionManifestSchema } from '@college-library/contracts';

const { Pool } = pg;

export class DatabaseLibrary {
  private readonly pool: pg.Pool;

  constructor(
    databaseUrl: string,
    private readonly processedDir: string,
    private readonly rawDir: string,
    private readonly includePending: boolean,
    private readonly embeddingApiUrl?: string,
    private readonly embeddingApiKey?: string,
    private readonly embeddingModel = 'text-embedding-3-small',
  ) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async syncFiles(): Promise<void> {
    const entries = await readdir(this.processedDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = ingestionManifestSchema.parse(
          JSON.parse(await readFile(join(this.processedDir, entry.name, 'manifest.json'), 'utf8')),
        );
        if (!this.includePending && manifest.metadata.licenseStatus !== 'verified') continue;
        await this.pool.query(
          `INSERT INTO documents
          (id, title, subject, subject_short_name, filename, mime_type, document_type, course_code, raw_object_key,
             source_sha256, raw_license, processed_license, raw_status, processed_status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, subject=EXCLUDED.subject,
             subject_short_name=EXCLUDED.subject_short_name, filename=EXCLUDED.filename,
             raw_license=EXCLUDED.raw_license, processed_license=EXCLUDED.processed_license,
             raw_status=EXCLUDED.raw_status, processed_status=EXCLUDED.processed_status,
             updated_at=now()`,
          [
            manifest.documentId, manifest.metadata.title, manifest.metadata.subject, manifest.metadata.subjectShortName,
            manifest.metadata.filename, manifest.metadata.mimeType, manifest.metadata.documentType, manifest.metadata.courseCode,
            join(manifest.documentId, manifest.metadata.filename), manifest.sourceSha256,
            manifest.metadata.rawLicense, manifest.metadata.processedLicense,
            manifest.metadata.licenseStatus === 'verified' ? 'verified' : 'private',
            manifest.metadata.licenseStatus === 'verified' ? 'published' : 'withheld',
            manifest.metadata.contributor,
          ],
        );
        for (const page of manifest.pages) {
          await this.pool.query(
            `INSERT INTO document_pages (document_id,page_number,text,confidence)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (document_id,page_number) DO UPDATE SET text=EXCLUDED.text, confidence=EXCLUDED.confidence`,
            [manifest.documentId, page.pageNumber, page.text, page.confidence ?? null],
          );
          await this.pool.query(`DELETE FROM chunks WHERE document_id=$1 AND page_start=$2`, [
            manifest.documentId, page.pageNumber,
          ]);
          await this.pool.query(
            `INSERT INTO chunks (document_id,page_start,page_end,content) VALUES ($1,$2,$2,$3)`,
            [manifest.documentId, page.pageNumber, page.text],
          );
        }
      } catch (error) {
        console.error(`Skipping ingestion package ${entry.name}:`, error);
        // Ignore incomplete ingestion packages; the local worker may still be writing them.
      }
    }
  }

  async search(query: string, courseCode: string | undefined, documentType: string | undefined, limit: number) {
    const result = await this.pool.query(
      `SELECT d.id AS "documentId", d.title, d.subject AS subject,
              d.subject_short_name AS "subjectShortName", d.course_code AS "courseCode",
              d.document_type AS "documentType", d.processed_status AS "processedStatus",
              MAX(ts_rank(c.search_vector, websearch_to_tsquery('english',$1))) AS score,
              json_agg(json_build_object('pageNumber',c.page_start,'excerpt',left(c.content,2000)) ORDER BY c.page_start) AS citations
       FROM chunks c JOIN documents d ON d.id=c.document_id
       WHERE ($2::text IS NULL OR d.course_code=$2)
         AND ($3::text IS NULL OR d.document_type=$3)
         AND d.processed_status = 'published'
         AND c.search_vector @@ websearch_to_tsquery('english',$1)
       GROUP BY d.id ORDER BY score DESC LIMIT $4`,
      [query, courseCode ?? null, documentType ?? null, limit],
    );
    if (result.rows.length > 0) return result.rows;
    const fallback = await this.pool.query(
      `SELECT d.id AS "documentId", d.title, d.subject AS subject,
              d.subject_short_name AS "subjectShortName", d.course_code AS "courseCode",
              d.document_type AS "documentType", d.processed_status AS "processedStatus",
              0::real AS score,
              json_agg(json_build_object('pageNumber', c.page_start, 'excerpt', left(c.content, 500)) ORDER BY c.page_start) AS citations
       FROM chunks c JOIN documents d ON d.id=c.document_id
       WHERE ($1::text IS NULL OR d.course_code=$1) AND d.processed_status='published'
       GROUP BY d.id ORDER BY d.title LIMIT $2`,
      [courseCode ?? null, limit],
    );
    return fallback.rows;
  }

  async retrieve(question: string, courseCode: string | undefined, tokenBudget: number) {
    const result = await this.pool.query(
      `SELECT d.id AS "documentId", d.title, c.page_start AS "pageNumber", c.content AS text
       FROM chunks c JOIN documents d ON d.id=c.document_id
       WHERE ($2::text IS NULL OR d.course_code=$2) AND d.processed_status='published'
         AND c.search_vector @@ websearch_to_tsquery('english',$1)
       ORDER BY ts_rank(c.search_vector, websearch_to_tsquery('english',$1)) DESC`,
      [question, courseCode ?? null],
    );
    const rows = result.rows.length > 0 ? result.rows : await this.pool.query(
      `SELECT d.id AS "documentId", d.title, c.page_start AS "pageNumber", c.content AS text
       FROM chunks c JOIN documents d ON d.id=c.document_id
       WHERE ($1::text IS NULL OR d.course_code=$1) AND d.processed_status='published'
       ORDER BY c.page_start`,
      [courseCode ?? null],
    ).then((fallback) => fallback.rows);
    let used = 0;
    return rows.flatMap((row) => {
      const remaining = tokenBudget * 4 - used;
      if (remaining <= 0) return [];
      const text = row.text.slice(0, remaining);
      used += text.length;
      return [{ ...row, text }];
    });
  }

  async subjects() {
    const result = await this.pool.query(
      `SELECT DISTINCT d.subject FROM documents d WHERE d.processed_status='published' ORDER BY d.subject`,
    );
    return result.rows.map((row) => row.subject);
  }

  async getDocument(documentId: string) {
    const result = await this.pool.query(
      `SELECT d.id AS "documentId", d.title, d.subject, d.subject_short_name AS "subjectShortName",
              d.course_code AS "courseCode", d.document_type AS "documentType", d.filename,
              d.processed_status AS "processedStatus",
              json_agg(json_build_object('pageNumber', p.page_number, 'text', p.text) ORDER BY p.page_number) AS pages
       FROM documents d JOIN document_pages p ON p.document_id=d.id
       WHERE d.id=$1 AND d.processed_status='published'
       GROUP BY d.id`,
      [documentId],
    );
    return result.rows[0] ?? undefined;
  }

  async raw(documentId: string) {
    const result = await this.pool.query(
      `SELECT filename, processed_status FROM documents WHERE id=$1`,
      [documentId],
    );
    const document = result.rows[0];
    if (!document || document.processed_status !== 'published') return undefined;
    return {
      filename: document.filename,
      path: join(this.rawDir, documentId, document.filename),
    };
  }

  async semanticSearch(query: string, courseCode: string | undefined, limit: number) {
    if (!this.embeddingApiUrl || !this.embeddingApiKey) return [];
    const response = await fetch(this.embeddingApiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.embeddingApiKey}` },
      body: JSON.stringify({ model: this.embeddingModel, input: query }),
    });
    if (!response.ok) throw new Error(`Embedding provider returned HTTP ${response.status}`);
    const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = payload.data?.[0]?.embedding;
    if (!embedding) throw new Error('Embedding provider returned no embedding');
    const result = await this.pool.query(
      `SELECT d.id AS "documentId", d.title, c.page_start AS "pageNumber", c.content AS text,
              1 - (e.embedding <=> $1::vector) AS score
       FROM chunk_embeddings e JOIN chunks c ON c.id=e.chunk_id JOIN documents d ON d.id=c.document_id
       WHERE ($2::text IS NULL OR d.course_code=$2) AND d.processed_status='published'
       ORDER BY e.embedding <=> $1::vector LIMIT $3`,
      [`[${embedding.join(',')}]`, courseCode ?? null, limit],
    );
    return result.rows;
  }
}
