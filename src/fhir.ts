import type { CapabilityStatement, SmartConfiguration } from './types.ts';

const ACCEPT = 'application/fhir+json, application/json;q=0.9';

export async function getJson<T>(url: string, timeoutMs = 30_000): Promise<{ status: number; body: T | null }> {
  const res = await fetch(url, { headers: { accept: ACCEPT }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return { status: res.status, body: null };
  return { status: res.status, body: (await res.json()) as T };
}

export async function fetchCapability(baseUrl: string): Promise<CapabilityStatement> {
  const { status, body } = await getJson<CapabilityStatement>(`${baseUrl.replace(/\/$/, '')}/metadata`);
  if (!body || body.resourceType !== 'CapabilityStatement') {
    throw new Error(`${baseUrl}/metadata returned ${status}, not a CapabilityStatement`);
  }
  return body;
}

/** SMART discovery is optional; 404/501 just means the server doesn't publish it. */
export async function fetchSmartConfiguration(baseUrl: string): Promise<SmartConfiguration | null> {
  try {
    const { body } = await getJson<SmartConfiguration>(`${baseUrl.replace(/\/$/, '')}/.well-known/smart-configuration`);
    return body && typeof body === 'object' && 'token_endpoint' in body ? body : null;
  } catch {
    return null;
  }
}
