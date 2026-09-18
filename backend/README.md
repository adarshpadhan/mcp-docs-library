# Library backend

This directory contains the backend/MCP implementation and deployment
configuration for the ARM64 server.

- API and remote MCP server
- PostgreSQL with pgvector
- Redis queue/rate-limit state
- Indexing worker
- HTTPS reverse proxy and operational configuration

The backend source is in [`src/`](./src/). Build and run the complete stack
from the repository root with:

```sh
cp .env.example .env
npm install
docker compose -f backend/docker-compose.yml up --build
```

The initial database migration is mounted from `infra/migrations/` and runs when
the PostgreSQL volume is created for the first time. The API health endpoint is
available at `http://localhost:8787/health`.
