# Cloudflare public HTTPS deployment

The backend is published through a named Cloudflare Tunnel. Cloudflare
terminates public HTTPS, so the backend can remain HTTP on `127.0.0.1:8787`;
the port must not be exposed publicly from the Oracle server.

The configured public hostname is:

```text
https://library.runloop.in
```

## One-time Cloudflare setup

The person performing these steps needs access to the Cloudflare account that
owns `runloop.in`.

1. Install `cloudflared` on the Oracle Ubuntu host:

   ```sh
   curl -L --output cloudflared.deb \
     https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
   sudo dpkg -i cloudflared.deb
   rm cloudflared.deb
   ```

   Use the `amd64` package instead if the Oracle instance is x86_64.

2. Authenticate in a browser:

   ```sh
   cloudflared tunnel login
   ```

   Select the `runloop.in` zone when Cloudflare asks for permission.

3. Create the named tunnel if it does not already exist:

   ```sh
   cloudflared tunnel create college-library
   cloudflared tunnel list
   ```

   If the tunnel already exists, keep its existing UUID. The checked-in
   [`tunnel.yml`](./tunnel.yml) uses
   `02ae3dbd-0a60-41aa-85f4-9bea1c65cdba`; replace it with the actual UUID if
   the Cloudflare account shows a different one.

4. Create the DNS record:

   ```sh
   cloudflared tunnel route dns college-library library.runloop.in
   ```

   This creates the proxied CNAME managed by Cloudflare. Do not create an
   additional A record for the Oracle public IP.

## Install the tunnel on Oracle

Copy the tunnel configuration and the tunnel credential JSON to the standard
system directory. The credential JSON is secret and must not be committed.

```sh
sudo install -d -m 700 /etc/cloudflared
sudo install -m 600 cloudflare/tunnel.yml /etc/cloudflared/config.yml
sudo cp "$HOME/.cloudflared/02ae3dbd-0a60-41aa-85f4-9bea1c65cdba.json" \
  /etc/cloudflared/
sudo chmod 600 /etc/cloudflared/02ae3dbd-0a60-41aa-85f4-9bea1c65cdba.json
```

Start the application before starting the tunnel:

```sh
docker compose -f backend/docker-compose.yml up -d --build
curl --fail http://127.0.0.1:8787/health
```

Install and enable the included systemd unit:

```sh
sudo install -m 644 cloudflare/cloudflared.service \
  /etc/systemd/system/cloudflared-college-library.service
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-college-library
sudo systemctl status cloudflared-college-library
```

Check tunnel logs if the public endpoint is unavailable:

```sh
sudo journalctl -u cloudflared-college-library -f
```

## Firewall and Cloudflare settings

The tunnel makes outbound connections to Cloudflare, so inbound port `8787`
does not need to be open. In the Oracle security list and host firewall:

- Keep SSH (`22`) restricted to trusted source IPs.
- Do not expose `8787` to the internet.
- Expose no application port publicly unless it is explicitly required.

In Cloudflare, keep SSL/TLS mode at **Full** or **Full (strict)** for other
proxied services. The tunnel hostname itself already provides public HTTPS.

For additional edge protection, create a Cloudflare WAF/rate-limit rule for
`library.runloop.in` (for example, challenge or block clients exceeding a
sustained request threshold) and keep the hostname proxied. Application rate
limiting protects the origin after traffic reaches the tunnel; it cannot stop a
volumetric attack before Cloudflare receives it.

## Verify the public domain

Run these after DNS propagation and the tunnel starts:

```sh
curl --fail https://library.runloop.in/health
curl --fail https://library.runloop.in/
```

The OAuth redirect URI must exactly be:

```text
https://library.runloop.in/auth/google/callback
```

Set the matching values in the Oracle `.env` file:

```env
PUBLIC_BASE_URL=https://library.runloop.in
GOOGLE_OAUTH_REDIRECT_URI=https://library.runloop.in/auth/google/callback
```

Restart the backend after changing `.env`:

```sh
docker compose -f backend/docker-compose.yml up -d --force-recreate backend
```

## Troubleshooting

- **502 from Cloudflare:** check `docker compose ps`, then
  `curl http://127.0.0.1:8787/health` on Oracle.
- **DNS does not resolve:** rerun
  `cloudflared tunnel route dns college-library library.runloop.in` and check
  that `library.runloop.in` has the Cloudflare-managed CNAME, not an unrelated
  A record.
- **Tunnel starts then stops:** verify that the UUID in `config.yml` matches
  the credential JSON filename and that the service can read both files.
- **OAuth redirect mismatch:** use the exact HTTPS callback above in both Google
  Cloud Console and `.env`; do not use the Oracle IP or port `8787`.
