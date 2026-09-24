#!/bin/sh
set -eu

cat >&2 <<'EOF'
Unlimited-OCR-MLX must run directly on the Apple Silicon host so MLX can use
Apple GPU acceleration. Apple Containers do not expose that device. Use:

  UNLIMITED_OCR_PYTHON=/path/to/.venv-ocr-mlx/bin/python \
  npm run dev:ingest:unlimited -- /path/to/document.pdf unlimited-ocr

Then publish the reviewed package with npm run publish:ingest.
EOF
exit 1
