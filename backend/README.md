# Library backend

This directory contains the backend/MCP implementation and deployment
configuration for the ARM64 server. Public HTTPS and browser OAuth are
provided by the separate [`frontend/`](../frontend/) services.

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
available internally at `http://localhost:8787/health`. The public endpoint is
served through Caddy at `https://library.runloop.in/health`.

## Rate limiting

The backend applies per-client-IP, per-route fixed-window rate limits and returns
HTTP `429` with `Retry-After` when a limit is exceeded. Defaults are 120 requests
per minute for general routes, 10 for `/auth/*`, 30 for `/oauth/*`, and 60 for
`/mcp`. Configure them with `RATE_LIMIT_WINDOW_MS` and the corresponding
`RATE_LIMIT_*_MAX_REQUESTS` variables. Caddy exposes only ports 80 and 443;
the backend port remains private on the Docker network.

## Google OAuth

The separate OAuth container in [`frontend/`](../frontend/) handles Google
login. In Google Cloud Console, create a Web OAuth client, add
`https://<your-domain>/auth/google/callback` as an authorized redirect URI, and
set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`GOOGLE_OAUTH_REDIRECT_URI`, and `AUTH_SESSION_SECRET` (at least 32 random
characters). Users start at `/auth/google`. Access is restricted to
`COLLEGE_DOMAIN`; the callback validates the verified Google email before
issuing an HttpOnly signed session cookie. Use `/auth/me` to inspect the
current session and `POST /auth/logout` to clear it.
