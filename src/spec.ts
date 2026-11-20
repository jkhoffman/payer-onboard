import type { CapabilityStatement, Expectation, Ext, SpecLayer, SpecResource } from './types.ts';

const EXPECTATION_URL = 'http://hl7.org/fhir/StructureDefinition/capabilitystatement-expectation';

function expectationOf(extensions: Ext[] | undefined): Expectation | undefined {
  const code = extensions?.find((e) => e.url === EXPECTATION_URL)?.valueCode;
  return code === 'SHALL' || code === 'SHOULD' || code === 'MAY' ? code : undefined;
}

/**
 * Build the spec layer from an implementation guide's server CapabilityStatement,
 * so requirements come from the IG itself rather than being retyped by hand.
 */
export function specFromCapabilityStatement(
  cs: CapabilityStatement & { version?: string; url?: string },
  id: string,
): SpecLayer {
  const server = cs.rest?.find((r) => r.mode === 'server');
  if (!server) throw new Error('IG CapabilityStatement has no server rest entry');

  const resources: Record<string, SpecResource> = {};
  for (const res of server.resource ?? []) {
    const expectation = expectationOf(res.extension);
    if (!expectation) continue;
    const interactions: Record<string, Expectation> = {};
    for (const i of res.interaction ?? []) {
      const e = expectationOf(i.extension);
      if (e) interactions[i.code] = e;
    }
    const search: Record<string, Expectation> = {};
    for (const s of res.searchParam ?? []) {
      const e = expectationOf(s.extension);
      if (e) search[s.name] = e;
    }
    resources[res.type] = {
      expectation,
      interactions,
      search,
      profiles: res.supportedProfile ?? [],
    };
  }

  return {
    spec: { id, version: cs.version ?? 'unknown', source: cs.url ?? 'unknown' },
    resources,
    auth: {
      mode: 'smart-app-launch',
      scopes: ['launch/patient', 'patient/ExplanationOfBenefit.read', 'patient/Coverage.read', 'patient/Patient.read'],
    },
    assumptions: {
      'rateLimit.requestsPerSecond':
        'Conservative guess. No payer publishes a rate limit in its CapabilityStatement; probe counts 429s and suggests a per-payer override.',
      'rateLimit.burst': 'Conservative guess; see rateLimit.requestsPerSecond.',
    },
    defaults: {
      rateLimit: { requestsPerSecond: 2, burst: 4 },
      retry: { maxAttempts: 4, baseDelayMs: 500 },
      paging: { style: 'next-link', pageSize: 50 },
      probe: { maxClaims: 200, maxPatients: 50, searchCheckCount: 20 },
    },
  };
}
