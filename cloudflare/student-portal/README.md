# Student Portal

This is the Cloudflare Workers/Pages boundary for the student-facing portal.
It is intentionally separate from the MCP backend: the portal handles browser
sessions and ingestion requests, while the backend stores originals, OCR output,
metadata, and searchable chunks.

## Planned responsibilities

- Google Workspace sign-in restricted to the college domain
- Course and document browsing
- Upload form for PDFs and images
- Upload status and OCR processing results
- License and attribution display
- Short-lived download links for published originals

## Ingestion path

```text
Student Portal (Cloudflare Pages/Worker)
  -> authenticated HTTPS upload request
Backend API (Oracle ARM VM, private origin)
  -> stores original in RAW_DATA_DIR
  -> OCR worker writes processed manifest/pages/chunks
PostgreSQL + pgvector
  -> stores metadata, OCR text, and search vectors
MCP clients
  -> search and retrieve published course content
```

The frontend must never write directly to PostgreSQL or expose the raw storage
mount. Uploads should go through an authenticated backend endpoint, where file
type, size, license metadata, and student permissions are checked before the
file is stored.

## Backend storage paths

On the backend host, the ingestion pipeline uses these paths:

- Upload originals: `local-ingest/data/raw/<document-id>/`
- OCR manifests, page text, and chunks: `local-ingest/data/processed/<document-id>/`
- PostgreSQL metadata and searchable records: Docker volume `postgres-data`
- Public ingestion API boundary: `POST /api/v1/ingestion/manifests` (currently
  reserved for the authenticated ingestion worker; student upload handling is
  not enabled yet)

The frontend should eventually upload through a dedicated authenticated upload
route that creates an ingestion job. It should not receive filesystem paths or
admin tokens. Until that route is implemented, ingestion remains a trusted
local-worker operation.

Shared contracts belong in `packages/contracts`; Cloudflare-specific code lives
in this directory.
