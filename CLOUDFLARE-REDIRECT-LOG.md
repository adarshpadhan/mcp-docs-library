# Cloudflare HTTP-to-HTTPS Redirect Log

**Date:** 2026-09-20  
**Zone:** `runloop.in`  
**Hostname:** `library.runloop.in`

## Verification

- `https://library.runloop.in/health` responds with `200 OK`.
- `http://library.runloop.in/health` currently responds with `200 OK`, so the
  Cloudflare edge redirect is not enabled.
- Cloudflare zone setting `always_use_https` was inspected and is currently
  `off`.

## Change Attempt

The Cloudflare zone settings update was attempted through the authenticated
Cloudflare control-plane tool:

```text
PATCH /zones/{zone_id}/settings
[{ "id": "always_use_https", "value": "on" }]
```

Cloudflare rejected the update:

```text
9109: Unauthorized to access requested resource
```

## Required Follow-up

The connected Cloudflare credential has read access but does not have permission
to edit zone settings. Grant the credential:

```text
Zone → Zone Settings → Edit
```

for the `runloop.in` zone, then enable **Always Use HTTPS** and verify:

```bash
curl -I http://library.runloop.in/health
```

Expected result:

```text
HTTP/1.1 301/302/308
Location: https://library.runloop.in/health
```

No API tokens, bearer tokens, or other credentials are included in this log.
