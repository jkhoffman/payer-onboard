import type {
  CapabilityStatement,
  DiscoveredResource,
  Gap,
  PayerLayer,
  SmartConfiguration,
  SpecLayer,
  VendorLayer,
} from './types.ts';

export interface DiscoveryInput {
  id: string;
  name: string;
  baseUrl: string;
  capability: CapabilityStatement;
  smart: SmartConfiguration | null;
  spec: SpecLayer;
  vendors: VendorLayer[];
  now?: Date;
}

const WRITE_INTERACTIONS = ['create', 'update', 'patch', 'delete'];

export function matchVendor(software: string, vendors: VendorLayer[]): VendorLayer | null {
  return vendors.find((v) => new RegExp(v.vendor.match.softwareName).test(software)) ?? null;
}

/**
 * Turn what a server says about itself into a payer layer, and list every
 * place the claim falls short of the spec. Claims only: `probe` tests behavior.
 */
export function discover(input: DiscoveryInput): PayerLayer {
  const { capability: cs, spec } = input;
  const server = cs.rest?.find((r) => r.mode === 'server') ?? cs.rest?.[0];
  const softwareName = cs.software?.name ?? 'unknown';
  const vendor = matchVendor(softwareName, input.vendors);

  const resources: Record<string, DiscoveredResource> = {};
  const gaps: Gap[] = [];
  let declaresSpecProfiles = false;
  let writeEnabled = false;

  for (const [type, req] of Object.entries(spec.resources)) {
    const res = server?.resource?.find((r) => r.type === type);
    if (!res) {
      if (req.expectation === 'SHALL') gaps.push({ resource: type, kind: 'resource', name: type, expectation: 'SHALL' });
      continue;
    }
    const found: DiscoveredResource = {
      interactions: (res.interaction ?? []).map((i) => i.code),
      search: (res.searchParam ?? []).map((s) => s.name),
      declaredProfiles: [res.profile, ...(res.supportedProfile ?? [])].filter((p): p is string => Boolean(p)),
    };
    resources[type] = found;

    if (found.interactions.some((i) => WRITE_INTERACTIONS.includes(i))) writeEnabled = true;

    for (const [name, exp] of Object.entries(req.interactions)) {
      if (exp === 'SHALL' && !found.interactions.includes(name)) gaps.push({ resource: type, kind: 'interaction', name, expectation: exp });
    }
    for (const [name, exp] of Object.entries(req.search)) {
      if (exp !== 'SHALL' || found.search.includes(name)) continue;
      const gap: Gap = { resource: type, kind: 'search', name, expectation: exp };
      // Searching by _id is the same lookup as a read; a server with read still serves the use case.
      if (name === '_id' && found.interactions.includes('read')) gap.equivalent = `GET ${type}/{id} (read)`;
      gaps.push(gap);
    }
    const specProfiles = req.profiles.map(stripVersion);
    const claimsOne = found.declaredProfiles.some((p) => specProfiles.includes(stripVersion(p)));
    if (claimsOne) declaresSpecProfiles = true;
    else if (req.expectation === 'SHALL' && req.profiles.length > 0) {
      gaps.push({ resource: type, kind: 'profile', name: req.profiles[0]!, expectation: 'SHALL' });
    }
  }

  return {
    payer: { id: input.id, name: input.name, baseUrl: input.baseUrl.replace(/\/$/, '') },
    discovered: {
      at: (input.now ?? new Date()).toISOString(),
      fhirVersion: cs.fhirVersion ?? 'unknown',
      software: { name: softwareName, ...(cs.software?.version ? { version: cs.software.version } : {}) },
      vendor: vendor?.vendor.id ?? null,
      declaresSpecProfiles,
      writeEnabled,
    },
    auth: authFrom(cs, input.smart, spec),
    resources,
    gaps,
  };
}

/** Gaps that count as failures: equivalents are reported but excluded. */
export function failingGaps(p: PayerLayer): Gap[] {
  return p.gaps.filter((g) => !g.equivalent);
}

/**
 * Rediscovery replaces everything discovered but keeps the human-owned
 * `overrides`, and reports what changed so drift is visible.
 */
export function rediscover(previous: PayerLayer | null, fresh: PayerLayer): { layer: PayerLayer; changes: string[] } {
  if (!previous) return { layer: fresh, changes: ['new payer'] };
  const changes: string[] = [];
  const key = (g: Gap) => `${g.resource}.${g.kind}:${g.name}`;
  const before = new Set(previous.gaps.map(key));
  const after = new Set(fresh.gaps.map(key));
  for (const g of after) if (!before.has(g)) changes.push(`new gap ${g}`);
  for (const g of before) if (!after.has(g)) changes.push(`gap closed ${g}`);
  const pv = previous.discovered.software;
  const fv = fresh.discovered.software;
  if (pv.name !== fv.name || pv.version !== fv.version) changes.push(`software ${pv.name} ${pv.version ?? ''} → ${fv.name} ${fv.version ?? ''}`);
  if (previous.auth.mode !== fresh.auth.mode) changes.push(`auth ${previous.auth.mode} → ${fresh.auth.mode}`);
  for (const k of ['authorizeUrl', 'tokenUrl'] as const) {
    const a = previous.auth.mode === 'smart-app-launch' ? previous.auth[k] : undefined;
    const b = fresh.auth.mode === 'smart-app-launch' ? fresh.auth[k] : undefined;
    if (a !== b) changes.push(`REVIEW: ${k} changed ${a ?? '(none)'} → ${b ?? '(none)'}; credentials will be sent there`);
  }
  const layer = previous.overrides ? { ...fresh, overrides: previous.overrides } : fresh;
  if (previous.overrides) changes.push(`kept overrides: ${Object.keys(previous.overrides).join(', ')}`);
  return { layer, changes };
}

function authFrom(cs: CapabilityStatement, smart: SmartConfiguration | null, spec: SpecLayer): PayerLayer['auth'] {
  const codes = (cs.rest ?? []).flatMap((r) => r.security?.service ?? []).flatMap((s) => s.coding ?? []).map((c) => c.code);
  const advertisesSmart = codes.includes('SMART-on-FHIR') || codes.includes('OAuth') || smart !== null;
  if (!advertisesSmart) return { mode: 'none' };
  const supported = smart?.scopes_supported ?? [];
  return {
    mode: 'smart-app-launch',
    ...(smart?.authorization_endpoint ? { authorizeUrl: smart.authorization_endpoint } : {}),
    ...(smart?.token_endpoint ? { tokenUrl: smart.token_endpoint } : {}),
    pkce: smart?.code_challenge_methods_supported?.includes('S256') ?? false,
    // A v2 ".rs" scope covers the v1 ".read" scope the spec layer lists.
    missingScopes: spec.auth.scopes.filter((s) => !supported.includes(s) && !supported.includes(s.replace(/\.read$/, '.rs'))),
  };
}

function stripVersion(url: string): string {
  return url.split('|')[0]!;
}
