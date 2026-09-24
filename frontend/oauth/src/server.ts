import Fastify from 'fastify';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import pg from 'pg';

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const port = Number(process.env.PORT ?? 3001);
const domain = required('COLLEGE_DOMAIN').toLowerCase();
const clientId = required('GOOGLE_OAUTH_CLIENT_ID');
const clientSecret = required('GOOGLE_OAUTH_CLIENT_SECRET');
const redirectUri = required('GOOGLE_OAUTH_REDIRECT_URI');
const sessionSecret = required('AUTH_SESSION_SECRET');
const publicBaseUrl = required('PUBLIC_BASE_URL').replace(/\/$/, '');
const internalSecret = required('OAUTH_INTERNAL_SECRET');
const pool = new pg.Pool({ connectionString: required('DATABASE_URL') });
const app = Fastify({ logger: true });
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));
const states = new Map<string, number>();
const mcpRequests = new Map<string, { clientId: string; redirectUri: string; state?: string; codeChallenge: string; expiresAt: number }>();
const codes = new Map<string, { clientId: string; redirectUri: string; email: string; codeChallenge: string; expiresAt: number }>();
const tokens = new Map<string, { clientId: string; email: string; expiresAt: number }>();
const clients = new Map<string, { client_name: string; redirect_uris: string[] }>();
const cookie = (value: string) => `library_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
const clearCookie = `library_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
const sign = (payload: string) => `${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`;
const verify = (value?: string) => { if (!value) return undefined; const [payload, signature] = value.split('.'); const expected = payload ? createHmac('sha256', sessionSecret).update(payload).digest('base64url') : ''; if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined; try { const session = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { email?: string; name?: string; exp?: number }; return session.exp && session.exp > Date.now() / 1000 ? session : undefined; } catch { return undefined; } };
const parseCookies = (header = '') => Object.fromEntries(header.split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter(([key, value]) => key && value));
const user = async (email: string, name?: string, googleSub?: string) => {
  await pool.query(
    `WITH saved_user AS (
       INSERT INTO users (email, name, google_sub) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name,
         google_sub=COALESCE(EXCLUDED.google_sub, users.google_sub), updated_at=now()
       RETURNING email
     )
     INSERT INTO subscriptions (email, status)
     SELECT email, 'active' FROM saved_user
     ON CONFLICT (email) DO NOTHING`,
    [email, name ?? null, googleSub ?? null],
  );
};
const googleRequest = async (url: string, init: RequestInit) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(8_000) });
const completeGoogle = async (code: string) => {
  const response = await googleRequest('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  if (!response.ok) throw new Error('google_token_exchange_failed');
  const tokens = await response.json() as { access_token?: string };
  if (!tokens.access_token) throw new Error('google_access_token_missing');
  const profileResponse = await googleRequest('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileResponse.ok) throw new Error('google_profile_fetch_failed');
  return await profileResponse.json() as { email?: string; name?: string; sub?: string; email_verified?: boolean; hd?: string };
};
const googleUrl = (state: string) => { const url = new URL('https://accounts.google.com/o/oauth2/v2/auth'); for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, hd: domain, prompt: 'select_account' })) url.searchParams.set(key, value); return url; };
app.get('/health', async () => ({ status: 'ok', service: 'college-library-oauth' }));
app.get('/auth/google', async (_request, reply) => { const state = randomBytes(32).toString('base64url'); states.set(state, Date.now() + 600000); return reply.redirect(googleUrl(state).toString()); });
app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/auth/google/callback', async (request, reply) => { const { code, state, error } = request.query; if (error) return reply.code(400).send({ error: 'google_oauth_denied' }); const expires = state ? states.get(state) : undefined; const mcp = state ? mcpRequests.get(state) : undefined; states.delete(state ?? ''); if (!code || !state || !expires || expires < Date.now()) return reply.code(400).send({ error: 'invalid_oauth_state' }); if (mcp) mcpRequests.delete(state); let profile; try { profile = await completeGoogle(code); } catch (e) { return reply.code(401).send({ error: e instanceof Error ? e.message : 'google_auth_failed' }); } const emailDomain = profile.email?.split('@')[1]?.toLowerCase(); if (!profile.email || !profile.email_verified || emailDomain !== domain || (profile.hd && profile.hd.toLowerCase() !== domain)) return reply.code(403).send({ error: 'college_domain_required' }); await user(profile.email, profile.name, profile.sub); if (mcp) { const authCode = randomBytes(32).toString('base64url'); codes.set(authCode, { clientId: mcp.clientId, redirectUri: mcp.redirectUri, email: profile.email, codeChallenge: mcp.codeChallenge, expiresAt: Date.now() + 60000 }); const redirect = new URL(mcp.redirectUri); redirect.searchParams.set('code', authCode); if (mcp.state) redirect.searchParams.set('state', mcp.state); redirect.searchParams.set('iss', publicBaseUrl); return reply.redirect(redirect.toString()); } const payload = Buffer.from(JSON.stringify({ email: profile.email, name: profile.name, exp: Math.floor(Date.now()/1000)+604800 })).toString('base64url'); return reply.header('set-cookie', cookie(sign(payload))).redirect('/'); });
app.get('/auth/me', async (request, reply) => { const session = verify(parseCookies(request.headers.cookie).library_session); if (!session) return reply.code(401).send({ error: 'unauthorized' }); const result = await pool.query('SELECT status, current_period_end FROM subscriptions WHERE email=$1', [session.email]); return { ...session, subscription: result.rows[0] ?? { status: 'inactive' } }; });
app.post('/auth/logout', async (_request, reply) => reply.header('set-cookie', clearCookie).send({ ok: true }));
app.delete('/auth/account', async (request, reply) => { const session = verify(parseCookies(request.headers.cookie).library_session); if (!session?.email) return reply.code(401).send({ error: 'unauthorized' }); await pool.query('DELETE FROM users WHERE email=$1', [session.email]); return reply.header('set-cookie', clearCookie).send({ ok: true }); });
app.get('/api/subscription', async (request, reply) => { const session = verify(parseCookies(request.headers.cookie).library_session); if (!session?.email) return reply.code(401).send({ error: 'unauthorized' }); const result = await pool.query('SELECT status, current_period_end FROM subscriptions WHERE email=$1', [session.email]); return result.rows[0] ?? { status: 'inactive', current_period_end: null }; });
app.get('/.well-known/oauth-authorization-server', async () => ({ issuer: publicBaseUrl, authorization_endpoint: `${publicBaseUrl}/oauth/authorize`, token_endpoint: `${publicBaseUrl}/oauth/token`, registration_endpoint: `${publicBaseUrl}/oauth/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'], authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ['none'] }));
app.get('/.well-known/oauth-protected-resource', async () => ({ resource: `${publicBaseUrl}/mcp`, authorization_servers: [publicBaseUrl], scopes_supported: ['openid','email','profile'] }));
app.get('/.well-known/oauth-protected-resource/mcp', async () => ({ resource: `${publicBaseUrl}/mcp`, authorization_servers: [publicBaseUrl], scopes_supported: ['openid','email','profile'] }));
app.get<{ Querystring: Record<string,string|undefined> }>('/oauth/authorize', async (request, reply) => { const { client_id, redirect_uri, response_type, state, code_challenge } = request.query; if (!client_id || response_type !== 'code' || !redirect_uri || !code_challenge || !/^https?:\/\//.test(redirect_uri)) return reply.code(400).send({ error: 'invalid_authorization_request' }); const client = clients.get(client_id); if (client && !client.redirect_uris.includes(redirect_uri)) return reply.code(400).send({ error: 'invalid_client' }); const oauthState = randomBytes(32).toString('base64url'); mcpRequests.set(oauthState, { clientId: client_id, redirectUri: redirect_uri, state, codeChallenge: code_challenge, expiresAt: Date.now()+600000 }); states.set(oauthState, Date.now()+600000); return reply.redirect(googleUrl(oauthState).toString()); });
app.post<{ Body: Record<string, unknown> }>('/oauth/token', async (request, reply) => { const body=request.body??{}; const code=typeof body.code==='string'?body.code:''; const clientIdValue=typeof body.client_id==='string'?body.client_id:''; const redirect=typeof body.redirect_uri==='string'?body.redirect_uri:''; const verifier=typeof body.code_verifier==='string'?body.code_verifier:''; const auth=codes.get(code); const challenge=createHash('sha256').update(verifier).digest('base64url'); if (!auth || auth.expiresAt<Date.now() || auth.clientId!==clientIdValue || auth.redirectUri!==redirect || auth.codeChallenge!==challenge) return reply.code(400).send({ error:'invalid_grant' }); codes.delete(code); const accessToken=randomBytes(32).toString('base64url'); tokens.set(accessToken,{clientId:clientIdValue,email:auth.email,expiresAt:Date.now()+3600000}); return { access_token: accessToken, token_type:'Bearer', expires_in:3600, scope:'openid email profile' }; });
app.post<{ Body: { client_name?: string; redirect_uris?: string[] } }>('/oauth/register', async (request) => { const id=`mcp-${randomBytes(16).toString('hex')}`; clients.set(id,{client_name:request.body?.client_name??'MCP client',redirect_uris:request.body?.redirect_uris??[]}); return { client_id:id, client_name:request.body?.client_name??'MCP client', redirect_uris:request.body?.redirect_uris??[], token_endpoint_auth_method:'none' }; });
app.post<{ Body: { token?: string } }>('/internal/introspect', async (request, reply) => { if (request.headers['x-internal-secret'] !== internalSecret) return reply.code(401).send({ error:'unauthorized' }); const token=request.body?.token; const session=typeof token==='string'?tokens.get(token):undefined; if (!session || session.expiresAt<Date.now()) return { active:false }; const subscription=await pool.query('SELECT status FROM subscriptions WHERE email=$1',[session.email]); return { active:true,email:session.email,client_id:session.clientId,subscription_status:subscription.rows[0]?.status??'inactive' }; });
app.listen({ host:'0.0.0.0', port }).catch((error) => { app.log.error(error); process.exitCode=1; });
