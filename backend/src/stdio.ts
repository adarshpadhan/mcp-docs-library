import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from '@college-library/config';
import { createMcpServer } from './mcp.js';
import { DatabaseLibrary } from './database-library.js';

const library = new DatabaseLibrary(config.DATABASE_URL, config.LIBRARY_DATA_DIR, config.RAW_DATA_DIR, config.MCP_INCLUDE_PENDING, config.EMBEDDING_API_URL, config.EMBEDDING_API_KEY, config.EMBEDDING_MODEL);
await library.syncFiles();
const server = createMcpServer(config.MCP_SERVER_NAME, config.MCP_SERVER_VERSION, library);
const transport = new StdioServerTransport();

await server.connect(transport);
