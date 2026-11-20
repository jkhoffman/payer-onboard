// SMART on FHIR authorization-code flow with PKCE, driven entirely by the
// payer layer that discovery wrote. Nothing here is payer-specific.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { ROOT } from './io.ts';
import type { PayerLayer } from './types.ts';

export interface StoredToken {
  member: string;
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
  patient?: string;
  scope?: string;
}

const tokenDir = (payer: string) => join(ROOT, '.tokens', payer);

export function loadEnv(): void {
  const f = join(ROOT, '.env.local');
  if (existsSync(f)) process.loadEnvFile(f);
}

/** Client credentials come from the environment: PAYER_<ID>_CLIENT_ID / _CLIENT_SECRET. */
export function clientCredentials(payerId: string): { id: string; secret?: string } {
  const key = payerId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const id = process.env[`PAYER_${key}_CLIENT_ID`];
  if (!id) throw new Error(`Set PAYER_${key}_CLIENT_ID (and _CLIENT_SECRET for confidential clients) in .env.local`);
  const secret = process.env[`PAYER_${key}_CLIENT_SECRET`];
  return secret ? { id, secret } : { id };
}

const b64url = (b: Buffer) => b.toString('base64url');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function authorizeUrl(payer: PayerLayer, clientId: string, redirectUri: string, scopes: string[], state: string, challenge: string): string {
  if (payer.auth.mode !== 'smart-app-launch' || !payer.auth.authorizeUrl) throw new Error(`${payer.payer.id} has no SMART authorize endpoint`);
  const u = new URL(payer.auth.authorizeUrl);
  u.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    aud: payer.payer.baseUrl,
  }).toString();
  return u.toString();
}

async function tokenRequest(payer: PayerLayer, body: Record<string, string>): Promise<Record<string, unknown>> {
  if (payer.auth.mode !== 'smart-app-launch' || !payer.auth.tokenUrl) throw new Error('no token endpoint');
  if (new URL(payer.auth.tokenUrl).protocol !== 'https:') throw new Error('refusing to send client credentials to a non-https token endpoint');
  const client = clientCredentials(payer.payer.id);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const form = new URLSearchParams(body);
  if (client.secret) headers['authorization'] = `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString('base64')}`;
  else form.set('client_id', client.id);
  const res = await fetch(payer.auth.tokenUrl, { method: 'POST', headers, body: form });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // Never echo the response on failure: it can contain tokens.
  if (!res.ok) throw new Error(`token endpoint returned ${res.status} (${String(json['error'] ?? 'no error code')})`);
  return json;
}

function toStored(member: string, j: Record<string, unknown>, previousRefresh?: string): StoredToken {
  const refresh = (j['refresh_token'] as string | undefined) ?? previousRefresh;
  return {
    member,
    access_token: String(j['access_token']),
    ...(refresh ? { refresh_token: refresh } : {}),
    expires_at: Date.now() + Number(j['expires_in'] ?? 3600) * 1000,
    ...(j['patient'] ? { patient: String(j['patient']) } : {}),
    ...(j['scope'] ? { scope: String(j['scope']) } : {}),
  };
}

const SAFE = /^[A-Za-z0-9_-]{1,64}$/;

export function saveToken(payerId: string, t: StoredToken): void {
  if (!SAFE.test(payerId) || !SAFE.test(t.member)) throw new Error('payer id and member label must be letters, digits, _ or -');
  mkdirSync(tokenDir(payerId), { recursive: true, mode: 0o700 });
  writeFileSync(join(tokenDir(payerId), `${t.member}.json`), JSON.stringify(t, null, 2), { mode: 0o600 });
}

export function listTokens(payerId: string): StoredToken[] {
  const dir = tokenDir(payerId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as StoredToken);
}

/** Returns a usable access token, refreshing it when it expires within a minute. */
export async function freshToken(payer: PayerLayer, t: StoredToken): Promise<StoredToken> {
  if (t.expires_at - Date.now() > 60_000) return t;
  if (!t.refresh_token) throw new Error(`token for ${t.member} expired and has no refresh token; run auth again`);
  const next = toStored(t.member, await tokenRequest(payer, { grant_type: 'refresh_token', refresh_token: t.refresh_token }), t.refresh_token);
  saveToken(payer.payer.id, next);
  return next;
}

/**
 * Run the browser half of the flow: print the authorize URL, receive the redirect
 * on a local port, exchange the code (with the PKCE verifier) for tokens.
 */
export async function authorize(payer: PayerLayer, member: string, scopes: string[], port = 8765, timeoutMs = 600_000): Promise<StoredToken> {
  const client = clientCredentials(payer.payer.id);
  const redirectUri = `http://localhost:${port}/callback`;
  const state = b64url(randomBytes(16));
  const { verifier, challenge } = pkcePair();
  console.log(`Open this URL and sign in as ${member}:\n${authorizeUrl(payer, client.id, redirectUri, scopes, state, challenge)}\n`);

  const code = await new Promise<string>((resolveCode, reject) => {
    const timer = setTimeout(() => { server.close(); reject(new Error('timed out waiting for the redirect')); }, timeoutMs);
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', redirectUri);
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const err = u.searchParams.get('error');
      const got = u.searchParams.get('code');
      const ok = !err && got && u.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' }).end(ok ? 'Authorized. You can close this tab.' : 'Authorization failed.');
      clearTimeout(timer);
      server.close();
      if (ok) resolveCode(got!);
      else reject(new Error(err ? `authorization denied: ${err}` : 'state mismatch or missing code'));
    });
    server.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'EADDRINUSE' ? `port ${port} is in use (another auth run still waiting?)` : e.message));
    });
    server.listen(port, '127.0.0.1');
  });

  const token = toStored(member, await tokenRequest(payer, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }));
  saveToken(payer.payer.id, token);
  return token;
}
