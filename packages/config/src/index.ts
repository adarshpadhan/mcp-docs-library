import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  COLLEGE_DOMAIN: z.string().min(3),
  R2_BUCKET: z.string().min(1),
  MCP_SERVER_NAME: z.string().default('college-library'),
  MCP_SERVER_VERSION: z.string().default('0.1.0'),
  ADMIN_INGEST_TOKEN: z.string().min(16),
  DOWNLOAD_SIGNING_SECRET: z.string().min(32),
  PUBLIC_BASE_URL: z.string().url().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  LIBRARY_DATA_DIR: z.string().default('local-ingest/data/processed'),
  MCP_INCLUDE_PENDING: z.coerce.boolean().default(false),
  HTTPS_CERT_FILE: z.string().optional(),
  HTTPS_KEY_FILE: z.string().optional(),
  RAW_DATA_DIR: z.string().default('local-ingest/data/raw'),
  EMBEDDING_API_URL: z.string().url().optional(),
  EMBEDDING_API_KEY: z.string().min(1).optional(),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
});

export const config = envSchema.parse(process.env);
