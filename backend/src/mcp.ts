import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DatabaseLibrary } from './database-library.js';

export function createMcpServer(
  name: string,
  version: string,
  library: DatabaseLibrary,
  createDownloadUrl?: (documentIds: string[]) => string,
): McpServer {
  const server = new McpServer({ name, version });

  server.registerTool(
    'search_library',
    {
      description: 'Search published, licensed college-library content.',
      inputSchema: {
        query: z.string().min(2),
        courseCode: z.string().optional(),
        documentType: z.enum(['notes', 'pyq', 'book', 'course-content', 'other']).optional(),
        limit: z.number().int().min(1).max(20).default(10),
      },
    },
    async ({ query, courseCode, documentType, limit }) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            query,
            filters: { courseCode, documentType },
            limit,
            results: await library.search(query, courseCode, documentType, limit),
          }),
        },
      ],
    }),
  );

  server.registerTool(
    'semantic_search',
    {
      description: 'Search indexed passages using vector embeddings when an embedding provider is configured.',
      inputSchema: {
        query: z.string().min(2),
        courseCode: z.string().optional(),
        limit: z.number().int().min(1).max(20).default(10),
      },
    },
    async ({ query, courseCode, limit }) => ({
      content: [{ type: 'text', text: JSON.stringify({ query, courseCode, limit, results: await library.semanticSearch(query, courseCode, limit) }) }],
    }),
  );

  server.registerTool(
    'get_document_text',
    {
      description: 'Return the exact page-preserving OCR text for a published document. Use this instead of summarizing when the user asks for the full or exact question paper text.',
      inputSchema: {
        documentId: z.string().uuid(),
      },
    },
    async ({ documentId }) => {
      const document = await library.getDocument(documentId);
      if (!document) throw new Error('Document is unavailable or not published');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...document,
            instruction: 'Preserve the page text exactly. Do not summarize, paraphrase, shorten, or omit questions unless the user explicitly requests a summary.',
          }),
        }],
      };
    },
  );

  server.registerTool(
    'retrieve_context',
    {
      description: 'Retrieve citation-ready passages from published content.',
      inputSchema: {
        question: z.string().min(5),
        courseCode: z.string().optional(),
        tokenBudget: z.number().int().min(100).max(8000).default(2000),
      },
    },
    async ({ question, courseCode, tokenBudget }) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            question,
            courseCode,
            tokenBudget,
            passages: await library.retrieve(question, courseCode, tokenBudget),
          }),
        },
      ],
    }),
  );

  server.registerResource(
    'library-subjects',
    'library://subjects',
    {
      description: 'Published subjects and course hierarchy.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await library.subjects()) }],
    }),
  );

  server.registerTool(
    'create_document_download_link',
    {
      description: 'Create a short-lived HTTPS link for the original PDF or a ZIP archive. Provide documentId for one document, or documentIds for 1–20 documents. Use this instead of returning an application/pdf MCP resource when the client cannot consume PDF resources.',
      inputSchema: z.object({
        documentId: z.string().uuid().optional(),
        documentIds: z.array(z.string().uuid()).min(1).max(20).optional(),
      }).refine(({ documentId, documentIds }) => Boolean(documentId) !== Boolean(documentIds), {
        message: 'Provide exactly one of documentId or documentIds',
      }),
    },
    async ({ documentId, documentIds: requestedDocumentIds }) => {
      if (!createDownloadUrl) throw new Error('Direct download links are not configured');
      const documentIds = requestedDocumentIds ?? [documentId!];
      const documents = await Promise.all(documentIds.map((documentId) => library.raw(documentId)));
      if (documents.some((document) => !document)) throw new Error('One or more documents are unavailable or not verified');
      const url = createDownloadUrl(documentIds);
      return { content: [{ type: 'text', text: JSON.stringify({ documentIds, filename: documentIds.length === 1 ? documents[0]?.filename : 'college-library-documents.zip', url, expiresInSeconds: 600, instruction: 'Open this HTTPS URL to download the original document or ZIP archive. Do not summarize or reconstruct it.' }) }] };
    },
  );

  return server;
}
