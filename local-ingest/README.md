# Local admin ingestion

This directory contains the admin MacBook Air ingestion workflow.

- Claim ingestion jobs from Oracle
- Download originals from private Cloudflare R2
- Run UnlimitedOCR and create page-preserving metadata
- Validate licenses, checksums, and OCR confidence
- Push reviewed manifests to Oracle over outbound HTTPS

The TypeScript CLI in `src/` is the deployment boundary for the MacBook worker
and its UnlimitedOCR adapter.

## Unlimited-OCR installation

The open-source repository is installed at
[`vendor/Unlimited-OCR/`](./vendor/Unlimited-OCR/), with the pinned source
commit recorded in [`vendor/Unlimited-OCR.VERSION`](./vendor/Unlimited-OCR.VERSION).
Python dependencies are listed in
[`requirements-unlimited-ocr.txt`](./requirements-unlimited-ocr.txt).

The Mac adapter is pinned separately from Baidu's upstream model/source commit;
both commits are recorded in `Unlimited-OCR.VERSION` and emitted metadata uses
the Mac adapter commit as `ocrVersion`.

The original upstream implementation documents an NVIDIA CUDA/SGLang runtime.
The vendored Mac adaptation provides an Apple-silicon MPS path and is the
runtime used by this project.

When the required runtime is available, process a permitted PDF with:

```sh
npm run dev:ingest:unlimited -- /path/to/pyq.pdf unlimited-ocr \
  title="Data Structures PYQ" courseCode=CSE-201 subject="Data Structures"
```

The Mac adapter converts PDF pages to images, invokes its Python runner directly,
preserves the source checksum, and writes a page-preserving ingestion package under
`local-ingest/data/processed/<documentId>/` containing `manifest.json` and one
Markdown file per page. It does not overwrite the original file.

## Publishing to the backend

After reviewing a generated package, publish it over the authenticated ingestion
transport:

```sh
ADMIN_INGEST_TOKEN="$ADMIN_INGEST_TOKEN" npm run publish:ingest -- \
  local-ingest/data/processed/<documentId> https://library.example
```

The backend validates the manifest, atomically stores `manifest.json` and page
Markdown under `LIBRARY_DATA_DIR`, then runs `syncFiles` so PostgreSQL full-text
and pgvector indexes are refreshed. Set `OCR_FORCE_CPU=1` when running in an
Apple container; the adapter otherwise selects MPS when available and always
falls back to CPU.

`Containerfile` and `container-publish.sh` provide a CPU-safe Apple Container
workflow that runs the existing local-ingest CLI and publishes its newest output.

Metadata fields currently include title, document type, course code, subject,
semester, exam year, language, contributor, raw/processed license, attribution,
source URL, rights notes, and license status. New output is
`pending_review` by default and must not be published until an administrator
verifies the rights.
