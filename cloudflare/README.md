# Cloudflare deployment

This directory contains the Cloudflare Workers/Pages frontend and R2 upload
orchestration.

- The planned student website lives in [`student-portal/`](./student-portal/).
- Student website and Google sign-in integration
- Short-lived presigned R2 upload/download URLs
- Private R2 object lifecycle and upload metadata
- Notifications to the Oracle API for new ingestion jobs

Shared validation and domain contracts live in `packages/`.
