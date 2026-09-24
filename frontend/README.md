# Frontend deployment

This directory contains the self-hosted frontend, Google OAuth service, and
Caddy HTTPS reverse proxy for the Oracle server. Cloudflare Tunnel is not used.

Traffic flow:

```text
Internet :443
  -> Caddy (automatic Let's Encrypt certificate)
  -> frontend:3000
     -> oauth:3001 for /auth/*
     -> backend:8787 for /mcp, /api, /oauth, and discovery
```

Set these values in the Oracle root `.env`:

```env
PUBLIC_HOSTNAME=library.runloop.in
ACME_EMAIL=your-real-email@example.com
PUBLIC_BASE_URL=https://library.runloop.in
GOOGLE_OAUTH_REDIRECT_URI=https://library.runloop.in/auth/google/callback
```

Point the `library.runloop.in` DNS A/AAAA record directly to the Oracle
instance. Allow inbound TCP ports 80 and 443 in both the Oracle security list
and host firewall. Do not expose port 8787, 3000, or 3001.

Start the complete stack from the repository root:

```sh
docker compose -f backend/docker-compose.yml up -d --build
curl --fail https://library.runloop.in/health
```

Google Cloud Console must contain this exact redirect URI:

```text
https://library.runloop.in/auth/google/callback
```

The OAuth container owns Google login, MCP OAuth discovery/authorization/token/registration, sessions, access tokens, and subscription checks. It issues the signed HttpOnly cookie and stores users/subscriptions in Postgres. The frontend only renders account/subscription UI and proxies `/auth` and `/oauth` to OAuth, and `/api`/`/mcp` to the backend. The backend introspects MCP bearer tokens through the OAuth service using `OAUTH_INTERNAL_SECRET`.
