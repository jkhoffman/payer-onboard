// Two independent observers of the same quality checks. `observeRaw` reads the FHIR
// resource exactly as the payer sent it; `observeNormalized` reads the canonical row.
// Neither looks at the normalizer's fix log. The scorer then reconciles the two against
// the log: every check that moved from fail to pass must be explained by a logged fix
// rule, and nothing may move from pass to fail. So the normalizer can't grade itself.
//
// The raw observer deliberately does not import normalize.ts. It reads the spec
// (terminology constants) and the payer config (alias tables) only.
import type { Resource } from './fhir-paths.ts';
import { validNpi } from './npi.ts';
import { ADJUDICATION, CARIN_CLAIM_TYPE, DATA_ABSENT, NPI, SAME_CODE_SYSTEMS, SYSTEM_ALIASES } from './terminology.ts';

export const CHECK_IDS = [
  'service-date', 'billed-amount', 'claim-type', 'claim-id', 'provider',
  'npi-valid', 'dates-are-dates', 'billed-not-sentinel',
  'code-systems', 'no-duplicate-codings', 'adjudication-coded', 'carin-profile',
  'period-order', 'not-future', 'paid-le-billed',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** true = pass, false = fail, null = not applicable to this claim. */
export type Observation = Record<CheckId, boolean | null>;

/** The only rules allowed to move each check from fail to pass. */
export const RULES_FOR_CHECK: Partial<Record<CheckId, string[]>> = {
  // Restoring a missing adjudication system is what makes a "submitted" total readable as billed.
  'billed-amount': ['vendor-amount-alias', 'adjudication-system-restored'],
  'dates-are-dates': ['date-to-day'],
  'code-systems': ['vendor-code-system-alias', 'code-system-alias'],
  'no-duplicate-codings': ['duplicate-coding'],
  'adjudication-coded': ['adjudication-system-restored'],
};

export interface ObserveConfig {
  codeSystemAliases: Record<string, string>;
  specProfiles: string[];
  today: string;
}

type Coding = { system?: string; code?: string };
type CC = { coding?: Coding[] };
type Code = { system: string | null; code: string };

const FHIR_DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
const isSentinel = (v: number) => /^9{3,}$/.test(String(Math.trunc(v)));

/** Shared definition of "canonical code system" for both observers. */
function systemsCanonical(codes: Code[], aliases: Record<string, string>): boolean {
  return codes.every((c) => c.system !== null && !(c.system in aliases) && !(c.system in SYSTEM_ALIASES) && !c.system.endsWith('unknown-icd-version'));
}

function noDuplicateCodings(codes: Code[]): boolean {
  return !SAME_CODE_SYSTEMS.some(([specific, loose]) => codes.some((c) => c.system === loose && codes.some((o) => o.system === specific && o.code === c.code)));
}

function plausibility(startIn: string | null, endIn: string | null, billed: number | null, paid: number | null, today: string) {
  // Compare calendar days, not strings: "2025-01-02T10:00:00Z" and "2025-01-02" are the same day.
  const start = startIn?.slice(0, 10) ?? null;
  const end = endIn?.slice(0, 10) ?? null;
  return {
    'billed-not-sentinel': billed === null ? null : !isSentinel(billed),
    'period-order': start && end ? end >= start : null,
    'not-future': start ? start <= today : null,
    'paid-le-billed': billed !== null && paid !== null ? paid <= billed : null,
  };
}

export function observeRaw(eob: Resource, cfg: ObserveConfig): Observation {
  const bp = (eob['billablePeriod'] as { start?: string; end?: string } | undefined) ?? {};
  const totals = (eob['total'] as Array<{ category?: CC; amount?: { value?: number } }> | undefined) ?? [];
  const amount = (system: string, code: string): unknown => totals.find((t) => t.category?.coding?.some((c) => c.system === system && c.code === code))?.amount?.value ?? null;
  const num = (v: unknown) => (typeof v === 'number' ? v : null); // the normalizer ignores non-numeric amounts too
  const billed = num(amount(ADJUDICATION, 'submitted'));
  const paid = num(amount(ADJUDICATION, 'benefit'));

  const provider = eob['provider'] as { reference?: string; identifier?: { system?: string; value?: string } } | undefined;
  let npi: string | null = provider?.identifier?.system === NPI ? provider.identifier.value ?? null : null;
  if (!npi && provider?.reference?.startsWith('#')) {
    const c = ((eob['contained'] as Resource[] | undefined) ?? []).find((r) => r.id === provider.reference!.slice(1));
    npi = ((c?.['identifier'] as Array<{ system?: string; value?: string }> | undefined) ?? []).find((i) => i.system === NPI)?.value ?? null;
  }

  const coded = (ccs: Array<CC | undefined>): Code[] =>
    ccs.flatMap((cc) => cc?.coding ?? []).filter((c) => c.code && c.system !== DATA_ABSENT).map((c) => ({ system: c.system ?? null, code: c.code! }));
  const dx = coded(((eob['diagnosis'] as Array<{ diagnosisCodeableConcept?: CC }> | undefined) ?? []).map((d) => d.diagnosisCodeableConcept));
  const px = coded(((eob['item'] as Array<{ productOrService?: CC }> | undefined) ?? []).map((i) => i.productOrService));
  const identifiers = (eob['identifier'] as Array<{ type?: CC; value?: string }> | undefined) ?? [];

  return {
    'service-date': Boolean(bp.start),
    'billed-amount': billed !== null,
    'claim-type': ((eob['type'] as CC | undefined)?.coding ?? []).some((c) => c.system === CARIN_CLAIM_TYPE && c.code),
    'claim-id': identifiers.some((i) => i.value && i.type?.coding?.some((c) => c.code === 'uc')),
    provider: npi !== null,
    'npi-valid': npi === null ? null : validNpi(npi),
    'dates-are-dates': bp.start || bp.end ? [bp.start, bp.end].every((d) => d === undefined || FHIR_DATE.test(d)) : null,
    'code-systems': systemsCanonical([...dx, ...px], cfg.codeSystemAliases),
    'no-duplicate-codings': noDuplicateCodings(dx) && noDuplicateCodings(px),
    'adjudication-coded': totals.every((t) => (t.category?.coding ?? []).every((c) => !c.code || Boolean(c.system))),
    'carin-profile': (eob.meta?.profile ?? []).some((p) => cfg.specProfiles.includes(p.split('|')[0]!)),
    ...plausibility(bp.start ?? null, bp.end ?? bp.start ?? null, billed, paid, cfg.today),
  };
}

export interface NormalizedRow {
  service_start: string | null;
  service_end: string | null;
  billed: number | null;
  paid: number | null;
  type: string | null;
  claim_id: string | null;
  billing_npi: string | null;
  provider_id_raw: string | null;
  diagnoses: string; // JSON Code[]
  procedures: string; // JSON Code[]
  carin_profile: number;
  amount_categories_coded: number; // 1 if every amount category in the canonical row has a system
}

export function observeNormalized(c: NormalizedRow, cfg: ObserveConfig): Observation {
  const dx = JSON.parse(c.diagnoses) as Code[];
  const px = JSON.parse(c.procedures) as Code[];
  return {
    'service-date': c.service_start !== null,
    'billed-amount': c.billed !== null,
    'claim-type': c.type !== null,
    'claim-id': c.claim_id !== null,
    provider: c.provider_id_raw !== null,
    'npi-valid': c.provider_id_raw === null ? null : c.billing_npi !== null && validNpi(c.billing_npi),
    'dates-are-dates': c.service_start || c.service_end ? [c.service_start, c.service_end].every((d) => d === null || FHIR_DATE.test(d)) : null,
    'code-systems': systemsCanonical([...dx, ...px], cfg.codeSystemAliases),
    'no-duplicate-codings': noDuplicateCodings(dx) && noDuplicateCodings(px),
    'adjudication-coded': c.amount_categories_coded === 1,
    'carin-profile': c.carin_profile === 1,
    ...plausibility(c.service_start, c.service_end, c.billed, c.paid, cfg.today),
  };
}
