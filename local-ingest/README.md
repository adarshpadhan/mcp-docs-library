# Local admin ingestion

This directory contains the admin MacBook Air ingestion workflow.

- Claim ingestion jobs from Oracle
- Download originals from private Cloudflare R2
- Run UnlimitedOCR and create page-preserving metadata
- Validate licenses, checksums, and OCR confidence
- Push reviewed manifests to Oracle over outbound HTTPS

The TypeScript CLI in `src/` is the deployment boundary for the MacBook worker
and its UnlimitedOCR adapter.

## Unlimited-OCR MLX installation

This project uses the Apple Silicon MLX port at
[LoJexLLM/Unlimited-OCR-MLX](https://huggingface.co/LoJexLLM/Unlimited-OCR-MLX).
The source and runtime provenance are recorded in
[`vendor/Unlimited-OCR.VERSION`](./vendor/Unlimited-OCR.VERSION), and Python
dependencies are listed in [`requirements-unlimited-ocr.txt`](./requirements-unlimited-ocr.txt).

Create a dedicated Python environment and download the model outside Git:

```sh
python3 -m venv local-ingest/.venv-ocr-mlx
local-ingest/.venv-ocr-mlx/bin/pip install -r local-ingest/requirements-unlimited-ocr.txt
huggingface-cli download LoJexLLM/Unlimited-OCR-MLX --local-dir local-ingest/models/Unlimited-OCR-MLX
```

The adapter runs MLX directly on macOS so Apple GPU acceleration is available.
Set `UNLIMITED_OCR_PYTHON` and `UNLIMITED_OCR_MODEL_DIR` when using non-default
locations. Apple Containers remain CPU-safe but are not the recommended MLX
execution path because they do not expose the host GPU.

When the required runtime is available, process a permitted PDF with:

```sh
npm run dev:ingest:unlimited -- /path/to/pyq.pdf unlimited-ocr \
  title="Data Structures PYQ" courseCode=CSE-201 subject="Data Structures"
```

The MLX adapter converts PDF pages to images, invokes the model runner directly,
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
and pgvector indexes are refreshed. OCR should run directly on macOS with MLX;
only the reviewed package publication needs to run in a container.

`container-publish.sh` intentionally refuses to run OCR in an Apple Container:
MLX requires direct access to the host Apple GPU. Run OCR on macOS, review the
package, then use `publish:ingest` (which may be run in a container) to send it
to the backend.

Metadata fields currently include title, document type, course code, subject,
semester, exam year, language, contributor, raw/processed license, attribution,
source URL, rights notes, and license status. New output is
`pending_review` by default and must not be published until an administrator
verifies the rights.
