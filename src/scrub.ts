// Recordings are published, so a patient without a clear synthetic marker is scrubbed
// before anything is written: the Patient keeps only an allowlist of fields, and every
// Coverage and claim that points at that patient loses its member-identifying fields.
// Public test servers accept writes from anyone, and we can't prove every record is fake.
import { createHash } from 'node:crypto';
import { relativeRef, type Resource } from './fhir-paths.ts';
import type { Recording } from './probe.ts';

type Name = { text?: string; family?: string; given?: string[] };
type Ident = { system?: string; value?: string; type?: unknown; use?: string };
type Ref = { reference?: string; display?: string; identifier?: Ident };

export const SCRUB_TAG = { system: 'https://github.com/jkhoffman/payer-onboard', code: 'scrubbed', display: 'Identifying fields replaced before publishing' };

/** Evidence that a patient is test data, or null if there is none. */
export function syntheticMarker(p: Resource): string | null {
  const tags = (p.meta as { tag?: Array<{ code?: string }> } | undefined)?.tag ?? [];
  if (tags.some((t) => t.code === 'HTEST')) return 'HTEST tag';
  const id = p.id ?? '';
  if (id.startsWith('-')) return 'negative id (CMS synthetic convention)';
  if (/-SYN-/i.test(id)) return 'SYN in id';
  const names = (p['name'] as Name[] | undefined) ?? [];
  const parts = names.flatMap((n) => [n.text ?? '', n.family ?? '', ...(n.given ?? [])]).filter(Boolean);
  if (parts.some((x) => /synthetic/i.test(x))) return 'name says synthetic';
  // Synthea, which generates most public FHIR test data, appends digits to every name part.
  if (parts.length > 0 && parts.every((x) => /\d{2,}$/.test(x))) return 'Synthea-style name';
  return null;
}

const hash = (v: string) => `sha256:${createHash('sha256').update(v).digest('hex').slice(0, 16)}`;
/** Hashing keeps cross-source member linking working (same value, same hash) while the raw value is gone. */
const hashIdent = (i: Ident): Ident => ({ ...(i.system ? { system: i.system } : {}), ...(i.type ? { type: i.type } : {}), ...(i.use ? { use: i.use } : {}), ...(i.value ? { value: hash(i.value) } : {}) });
const tagged = (r: Resource): Resource['meta'] => {
  const meta = { ...(r.meta ?? {}) } as Record<string, unknown>;
  meta['tag'] = [...((meta['tag'] as unknown[]) ?? []), SCRUB_TAG];
  return meta as Resource['meta'];
};

/**
 * Allowlist, not denylist: anything not named here is dropped, including extensions
 * (race, ethnicity, birth sex), contained resources, narrative and free text.
 */
export function scrubPatient(p: Resource): Resource {
  return {
    resourceType: 'Patient',
    ...(p.id ? { id: p.id } : {}),
    meta: tagged(p),
    identifier: ((p['identifier'] as Ident[] | undefined) ?? []).map(hashIdent),
    name: [{ family: 'Scrubbed', given: ['Patient'] }],
    ...(typeof p['gender'] === 'string' ? { gender: p['gender'] } : {}),
    ...(typeof p['birthDate'] === 'string' ? { birthDate: (p['birthDate'] as string).slice(0, 4) } : {}), // year only
    ...(typeof p['deceasedBoolean'] === 'boolean' ? { deceasedBoolean: p['deceasedBoolean'] } : {}),
  };
}

/** A reference stays a reference; its display text and any embedded identifier go. */
function scrubRef(r: Ref | undefined): Ref | undefined {
  if (!r) return r;
  return { ...(r.reference ? { reference: r.reference } : {}), ...(r.identifier ? { identifier: hashIdent(r.identifier) } : {}) };
}

/** Recursively drop `display` from every Reference (an object with `reference` or `identifier`). Coding displays stay. */
function stripRefDisplays(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripRefDisplays);
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const isRef = ('reference' in o || ('identifier' in o && !Array.isArray(o['identifier']))) && !('coding' in o);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) {
    if (isRef && k === 'display') continue;
    out[k] = stripRefDisplays(x);
  }
  return out;
}

/** Contained resources that describe a person are dropped; providers and organizations stay (they hold the NPI). */
const PERSON_TYPES = new Set(['Patient', 'RelatedPerson', 'Person']);
const keepContained = (c: unknown) => !PERSON_TYPES.has((c as Resource)?.resourceType ?? 'Patient');

/** Coverage for a scrubbed member: member ids hashed; names, dependents, extensions and free text dropped. */
export function scrubCoverage(c: Resource): Resource {
  const out = stripRefDisplays({ ...c, meta: tagged(c) }) as Resource;
  for (const k of ['text', 'extension', 'modifierExtension', 'dependent']) delete out[k];
  if (Array.isArray(c['contained'])) out['contained'] = (c['contained'] as unknown[]).filter(keepContained);
  if (typeof c['subscriberId'] === 'string') out['subscriberId'] = hash(c['subscriberId'] as string);
  if (Array.isArray(c['identifier'])) out['identifier'] = (c['identifier'] as Ident[]).map(hashIdent);
  for (const k of ['beneficiary', 'subscriber', 'policyHolder']) if (c[k]) out[k] = scrubRef(c[k] as Ref);
  // Class values (group, plan) can embed member numbers on some payers; keep the type, hash the value.
  if (Array.isArray(c['class'])) {
    out['class'] = (c['class'] as Array<Record<string, unknown>>).map(({ name: _name, ...k }) => ({ ...k, ...(typeof k['value'] === 'string' ? { value: hash(k['value'] as string) } : {}) }));
  }
  return out;
}

/**
 * A claim for a scrubbed (or unresolvable) member keeps its billing content: codes, dates,
 * amounts, provider. Anything that can locate or name the person goes: reference displays,
 * contained person resources, addresses, accident details, extensions and free text.
 */
export function scrubClaim(e: Resource): Resource {
  const out = stripRefDisplays({ ...e, meta: tagged(e) }) as Resource;
  for (const k of ['text', 'processNote', 'accident', 'extension', 'modifierExtension']) delete out[k];
  if (Array.isArray(e['contained'])) out['contained'] = (e['contained'] as unknown[]).filter(keepContained);
  out['patient'] = scrubRef(e['patient'] as Ref);
  if (Array.isArray(out['item'])) {
    out['item'] = (out['item'] as Array<Record<string, unknown>>).map(({ locationAddress: _addr, extension: _ext, ...rest }) => rest);
  }
  if (Array.isArray(out['supportingInfo'])) {
    // Free text can carry anything; coded entries stay.
    out['supportingInfo'] = (out['supportingInfo'] as Array<Record<string, unknown>>).map(({ valueString: _s, valueAttachment: _a, ...rest }) => rest);
  }
  return out;
}

/**
 * Fails closed: a claim or Coverage is published unscrubbed only if its member is a
 * recorded Patient that carries a synthetic marker. A member that wasn't fetched (e.g.
 * past the patient cap), is contained, is referenced only by identifier, or can't be
 * resolved is treated as unknown, and unknown is scrubbed.
 */
export function scrubRecording(rec: Recording): { rec: Recording; count: number; unresolved: number } {
  const synthetic = new Set<string>();
  let count = 0;
  const Patient = rec.Patient.map((p) => {
    if (syntheticMarker(p)) {
      synthetic.add(`Patient/${p.id}`);
      return p;
    }
    count++;
    return scrubPatient(p);
  });
  const known = (ref: Ref | undefined) => {
    const r = relativeRef(ref?.reference);
    return r !== undefined && synthetic.has(r);
  };
  let unresolved = 0;
  const Coverage = rec.Coverage.map((c) => (known(c['beneficiary'] as Ref) ? c : scrubCoverage(c)));
  const ExplanationOfBenefit = rec.ExplanationOfBenefit.map((e) => {
    if (known(e['patient'] as Ref)) return e;
    const r = relativeRef((e['patient'] as Ref | undefined)?.reference);
    if (!r || !rec.Patient.some((p) => `Patient/${p.id}` === r)) unresolved++;
    return scrubClaim(e);
  });
  return { rec: { ...rec, Patient, Coverage, ExplanationOfBenefit }, count, unresolved };
}
