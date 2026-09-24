#!/bin/sh
set -eu
: "${ADMIN_INGEST_TOKEN:?Set ADMIN_INGEST_TOKEN}"
INPUT_PDF=${1:?Usage: $0 /path/to/input.pdf [backend-url]}
BACKEND_URL=${2:-http://host.docker.internal:8787}
npm run dev:ingest:unlimited -- "$INPUT_PDF" unlimited-ocr
# The CLI writes its package under local-ingest/data; publish the newest package.
LATEST=$(find local-ingest/data/processed -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)
npm run publish:ingest -- "$LATEST" "$BACKEND_URL"
