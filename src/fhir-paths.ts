// Small, explicit readers for the few EOB fields the probe and normalizer need.

export interface Resource {
  resourceType: string;
  id?: string;
  meta?: { lastUpdated?: string; profile?: string[] };
  [k: string]: unknown;
}

export interface Bundle {
  resourceType: 'Bundle';
  total?: number;
  link?: Array<{ relation: string; url: string }>;
  entry?: Array<{ resource?: Resource }>;
}

type Coding = { system?: string; code?: string };
type Identifier = { system?: string; value?: string; type?: { coding?: Coding[] } };

export const nextLink = (b: Bundle): string | undefined => b.link?.find((l) => l.relation === 'next')?.url;
export const entries = (b: Bundle): Resource[] => (b.entry ?? []).map((e) => e.resource).filter((r): r is Resource => Boolean(r));

/** "Patient/123", "https://x/r4/Patient/123", "Patient/123/_history/2" → "Patient/123". */
export function relativeRef(ref: string | undefined): string | undefined {
  if (!ref || ref.startsWith('#')) return undefined;
  const m = ref.replace(/\/_history\/[^/]+$/, '').match(/([A-Z][A-Za-z]+\/[A-Za-z0-9\-.]{1,64})$/);
  return m?.[1];
}

export const patientRef = (eob: Resource) => relativeRef((eob['patient'] as { reference?: string } | undefined)?.reference);

export const typeCoding = (eob: Resource): Coding | undefined => (eob['type'] as { coding?: Coding[] } | undefined)?.coding?.[0];

export const identifiers = (r: Resource): Identifier[] => (r['identifier'] as Identifier[] | undefined) ?? [];

export function billablePeriod(eob: Resource): { start?: string; end?: string } {
  return (eob['billablePeriod'] as { start?: string; end?: string } | undefined) ?? {};
}

export const coverageRefs = (eob: Resource): string[] =>
  ((eob['insurance'] as Array<{ coverage?: { reference?: string } }> | undefined) ?? [])
    .map((i) => relativeRef(i.coverage?.reference))
    .filter((r): r is string => Boolean(r));

export const day = (iso: string | undefined) => iso?.slice(0, 10);
