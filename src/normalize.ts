// Normalize recorded FHIR into canonical Claim / Member rows. Every change is a named
// fix; every problem that can't be fixed honestly is a named issue. Nothing is invented.
import { billablePeriod, day, identifiers, patientRef, type Resource } from './fhir-paths.ts';
import {
  ADJUDICATION,
  ADJUDICATION_CODES,
  C4BB_ADJUDICATION,
  C4BB_ADJUDICATION_CODES,
  CARIN_CLAIM_TYPE,
  DATA_ABSENT,
  NPI,
  SAME_CODE_SYSTEMS,
  SYSTEM_ALIASES,
} from './terminology.ts';

export interface NormalizeConfig {
  /** Payer-specific code-system spellings → canonical URI (vendor layer). */
  codeSystemAliases: Record<string, string>;
  /** Payer-specific adjudication category codes that mean a canonical amount (vendor layer). */
  amountAliases: { billed?: string[]; paid?: string[] };
  /** CARIN profile URLs, to note claims that don't claim conformance. */
  specProfiles: string[];
}

export interface Code {
  system: string | null;
  code: string;
}

export interface Claim {
  key: string; // payer:resourceId
  payer: string;
  sourceId: string;
  memberKey: string | null;
  claimId: string | null; // CARIN unique claim id ("uc")
  type: string | null; // CARIN claim-type code
  status: string | null;
  serviceStart: string | null;
  serviceEnd: string | null;
  billingNpi: string | null;
  /** Provider id as sent, before validation. Used only to propose review candidates. */
  providerIdRaw: string | null;
  diagnoses: Code[];
  procedures: Code[];
  billed: number | null;
  paid: number | null;
  carinProfile: boolean;
  /** meta.security codes (e.g. R, N, PSY, ETH). Survivors inherit their duplicates' labels. */
  security: string[];
  /** Every amount category on the canonical claim carries a code system (after any restoration). */
  amountCategoriesCoded: boolean;
}

export interface Member {
  key: string; // payer:Patient/id
  payer: string;
  identifiers: Array<{ system: string; value: string }>;
}

export interface Fix {
  key: string;
  rule: string;
  field: string;
  from: string;
  to: string;
}

export interface Issue {
  key: string;
  rule: string;
  field: string;
  detail: string;
}

type Coding = { system?: string; code?: string };
type CodeableConcept = { coding?: Coding[] };

export function normalizeClaim(eob: Resource, payer: string, cfg: NormalizeConfig): { claim: Claim; fixes: Fix[]; issues: Issue[] } {
  const key = `${payer}:${eob.id ?? '?'}`;
  const fixes: Fix[] = [];
  const issues: Issue[] = [];
  const fix = (rule: string, field: string, from: string, to: string) => fixes.push({ key, rule, field, from, to });
  const issue = (rule: string, field: string, detail: string) => issues.push({ key, rule, field, detail });

  const canonSystem = (system: string | undefined, field: string): string | null => {
    if (!system) return null;
    const to = cfg.codeSystemAliases[system] ?? SYSTEM_ALIASES[system];
    if (to && to !== system) {
      fix(cfg.codeSystemAliases[system] ? 'vendor-code-system-alias' : 'code-system-alias', field, system, to);
      return to;
    }
    return system;
  };

  const codesFrom = (concepts: Array<CodeableConcept | undefined>, field: string): Code[] => {
    const out: Code[] = [];
    for (const cc of concepts) {
      for (const c of cc?.coding ?? []) {
        if (!c.code) continue;
        const system = canonSystem(c.system, field);
        if (system === DATA_ABSENT) continue; // "no code" is absence, not a code
        if (!system) issue('missing-code-system', field, `code ${c.code} has no system`);
        if (system?.endsWith('unknown-icd-version')) issue('unknown-icd-version', field, `code ${c.code}`);
        out.push({ system, code: c.code });
      }
    }
    // Drop a coding repeated under a less specific system (CMS lists ICD-10 dx as both icd-10-cm and icd-10).
    return out.filter((c) => {
      for (const [specific, loose] of SAME_CODE_SYSTEMS) {
        if (c.system === loose && out.some((o) => o.system === specific && o.code === c.code)) {
          fix('duplicate-coding', field, `${loose}|${c.code}`, `kept ${specific}|${c.code}`);
          return false;
        }
      }
      return true;
    }).filter((c, i, arr) => arr.findIndex((o) => o.system === c.system && o.code === c.code) === i);
  };

  // Dates: CARIN wants dates; some servers send full timestamps.
  const bp = billablePeriod(eob);
  const asDay = (v: string | undefined, field: string) => {
    if (!v) return null;
    const d = day(v)!;
    if (d !== v) fix('date-to-day', field, v, d);
    return d;
  };
  const serviceStart = asDay(bp.start, 'billablePeriod.start');
  const serviceEnd = asDay(bp.end, 'billablePeriod.end') ?? serviceStart;
  if (!serviceStart) issue('no-service-date', 'billablePeriod', 'billablePeriod.start missing');

  // Claim type: only the CARIN claim-type coding counts; never guessed from payer codes.
  const typeCodings = ((eob['type'] as CodeableConcept | undefined)?.coding ?? []);
  const type = typeCodings.find((c) => c.system === CARIN_CLAIM_TYPE)?.code ?? null;
  if (!type) issue('no-carin-claim-type', 'type', `codings: ${typeCodings.map((c) => c.code).join(',') || 'none'}`);

  const claimId = identifiers(eob).find((i) => i.type?.coding?.some((c) => c.code === 'uc'))?.value ?? null;
  if (!claimId) issue('no-claim-id', 'identifier', 'no CARIN unique claim id (uc)');

  const rawNpi = providerNpi(eob);
  const billingNpi = rawNpi && validNpi(rawNpi) ? rawNpi : null;
  if (rawNpi && !billingNpi) issue('invalid-npi', 'provider', `"${rawNpi}" fails the NPI check digit; not used for matching`);
  if (!rawNpi) issue('no-billing-npi', 'provider', 'no NPI on provider or its contained resource');

  const diagnoses = codesFrom(
    ((eob['diagnosis'] as Array<{ diagnosisCodeableConcept?: CodeableConcept }> | undefined) ?? []).map((d) => d.diagnosisCodeableConcept),
    'diagnosis',
  );
  const procedures = codesFrom(
    ((eob['item'] as Array<{ productOrService?: CodeableConcept }> | undefined) ?? []).map((i) => i.productOrService),
    'item.productOrService',
  );

  const { billed, paid, categoriesCoded: amountCategoriesCoded } = amounts(eob, cfg, fix, issue);

  const profiles = eob.meta?.profile ?? [];
  const carinProfile = profiles.some((p) => cfg.specProfiles.includes(p.split('|')[0]!));
  if (!carinProfile) issue('no-carin-profile', 'meta.profile', 'claim does not declare a CARIN profile');

  const ref = patientRef(eob);
  return {
    claim: {
      key,
      payer,
      sourceId: eob.id ?? '?',
      memberKey: ref ? `${payer}:${ref}` : null,
      claimId,
      type,
      status: (eob['status'] as string | undefined) ?? null,
      serviceStart,
      serviceEnd,
      billingNpi,
      providerIdRaw: rawNpi,
      diagnoses,
      procedures,
      billed,
      paid,
      carinProfile,
      amountCategoriesCoded,
      security: [...new Set(((eob.meta as { security?: Array<{ code?: string }> } | undefined)?.security ?? []).map((x) => x.code).filter((x): x is string => Boolean(x)))].sort(),
    },
    fixes,
    issues,
  };
}

export { validNpi } from './npi.ts';
import { validNpi } from './npi.ts';

function providerNpi(eob: Resource): string | null {
  const provider = eob['provider'] as { reference?: string; identifier?: { system?: string; value?: string } } | undefined;
  if (provider?.identifier?.system === NPI && provider.identifier.value) return provider.identifier.value;
  const ref = provider?.reference;
  if (ref?.startsWith('#')) {
    const contained = ((eob['contained'] as Resource[] | undefined) ?? []).find((c) => c.id === ref.slice(1));
    const npi = contained ? identifiers(contained).find((i) => i.system === NPI)?.value : undefined;
    if (npi) return npi;
  }
  return null;
}

function amounts(
  eob: Resource,
  cfg: NormalizeConfig,
  fix: (rule: string, field: string, from: string, to: string) => void,
  issue: (rule: string, field: string, detail: string) => void,
): { billed: number | null; paid: number | null; categoriesCoded: boolean } {
  const totals = (eob['total'] as Array<{ category?: CodeableConcept; amount?: { value?: number } }> | undefined) ?? [];
  let billed: number | null = null;
  let paid: number | null = null;
  let categoriesCoded = true;
  for (const t of totals) {
    for (const c of t.category?.coding ?? []) {
      if (!c.code) continue;
      let system = c.system;
      if (!system && ADJUDICATION_CODES.has(c.code)) {
        fix('adjudication-system-restored', 'total.category', `(none)|${c.code}`, `${ADJUDICATION}|${c.code}`);
        system = ADJUDICATION;
      } else if (!system && C4BB_ADJUDICATION_CODES.has(c.code)) {
        fix('adjudication-system-restored', 'total.category', `(none)|${c.code}`, `${C4BB_ADJUDICATION}|${c.code}`);
        system = C4BB_ADJUDICATION;
      }
      if (!system) categoriesCoded = false;
      if (typeof t.amount?.value !== 'number') continue;
      const v = t.amount.value;
      if (billed === null && system === ADJUDICATION && c.code === 'submitted') billed = v;
      else if (billed === null && cfg.amountAliases.billed?.includes(c.code)) {
        billed = v;
        fix('vendor-amount-alias', 'total', c.code, 'billed');
      }
      if (paid === null && ((system === ADJUDICATION && c.code === 'benefit') || (system === C4BB_ADJUDICATION && c.code === 'paidtoprovider'))) paid = v;
      else if (paid === null && cfg.amountAliases.paid?.includes(c.code)) {
        paid = v;
        fix('vendor-amount-alias', 'total', c.code, 'paid');
      }
    }
  }
  if (billed === null) issue('no-billed-amount', 'total', 'no submitted/billed total');
  if (!categoriesCoded) issue('uncoded-amount-category', 'total.category', 'an amount category has no system and no known code');
  return { billed, paid, categoriesCoded };
}

export function normalizeMember(p: Resource, payer: string): Member {
  return {
    key: `${payer}:Patient/${p.id}`,
    payer,
    identifiers: identifiers(p).filter((i): i is { system: string; value: string } => Boolean(i.system && i.value)).map((i) => ({ system: i.system!, value: i.value! })),
  };
}

// ---------- members: deterministic linking only ----------

/** Union-find over members that share an identifier (same system and value). No name/DOB matching. */
export function linkMembers(members: Member[]): Map<string, { golden: string; evidence: string | null }> {
  const parent = new Map(members.map((m) => [m.key, m.key]));
  const evidence = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const owner = new Map<string, string>();
  for (const m of members) {
    for (const id of m.identifiers) {
      const token = `${id.system}|${id.value}`;
      const other = owner.get(token);
      if (!other) {
        owner.set(token, m.key);
        continue;
      }
      const [a, b] = [find(other), find(m.key)].sort();
      if (a !== b) {
        parent.set(b!, a!);
        evidence.set(m.key, token);
        evidence.set(other, token);
      }
    }
  }
  return new Map(members.map((m) => [m.key, { golden: find(m.key), evidence: evidence.get(m.key) ?? null }]));
}

// ---------- claims: dedupe ----------

export interface Duplicate {
  key: string;
  duplicateOf: string;
  rule: 'same-claim-id' | 'fingerprint';
  evidence: string;
}

/**
 * A fingerprint needs a valid billing NPI and at least one procedure code. Without
 * them "same person, same day, same amount" merges different claims (seen in Firely
 * test data with placeholder NPIs), and a false merge is worse than a missed duplicate.
 */
export function fingerprint(c: Claim, golden: string | null): string | null {
  if (!golden || !c.serviceStart || !c.billingNpi || c.procedures.length === 0) return null;
  const codes = c.procedures.map((p) => `${p.system}|${p.code}`).sort().join(',');
  return [golden, c.type ?? '-', c.serviceStart, c.billingNpi, codes, c.billed ?? '-'].join('~');
}

/**
 * Same payer + same CARIN claim id → the same claim (re-sent or on two pages).
 * Otherwise, same person + date + billing NPI + codes + billed amount → the same
 * claim reported by two sources. Duplicates are marked, never deleted.
 */
export interface ReviewCandidate {
  key: string;
  candidateOf: string;
  reasons: string[]; // why this was not merged automatically
  evidence: string;
}

/**
 * Pairs that match on everything a fingerprint uses, except that the provider id
 * isn't a valid NPI. They go to a person with the evidence; they are never merged here.
 */
export function reviewCandidates(claims: Claim[], golden: (memberKey: string | null) => string | null, alreadyDuplicate: Set<string>): ReviewCandidate[] {
  const out: ReviewCandidate[] = [];
  const seen = new Map<string, Claim>();
  for (const c of [...claims].sort((a, b) => a.key.localeCompare(b.key))) {
    const g = golden(c.memberKey);
    if (alreadyDuplicate.has(c.key) || c.billingNpi || !c.providerIdRaw || !g || !c.serviceStart || c.procedures.length === 0) continue;
    const codes = c.procedures.map((p) => `${p.system}|${p.code}`).sort().join(',');
    const k = [g, c.type ?? '-', c.serviceStart, c.providerIdRaw, codes, c.billed ?? '-'].join('~');
    const first = seen.get(k);
    if (!first) {
      seen.set(k, c);
      continue;
    }
    const reasons = [`provider id "${c.providerIdRaw}" fails the NPI check digit`];
    if (c.billed !== null && /^9{3,}(\.0+)?$/.test(String(c.billed))) reasons.push(`billed amount ${c.billed} looks like a sentinel value`);
    if (c.memberKey !== first.memberKey) reasons.push('different source records for one linked person');
    out.push({ key: c.key, candidateOf: first.key, reasons, evidence: k.split('~').slice(1).join(' · ') });
  }
  return out;
}

export function dedupeClaims(claims: Claim[], golden: (memberKey: string | null) => string | null): Duplicate[] {
  const dups: Duplicate[] = [];
  const sorted = [...claims].sort((a, b) => a.key.localeCompare(b.key));
  const seenId = new Map<string, string>();
  const isDup = new Set<string>();
  for (const c of sorted) {
    if (!c.claimId) continue;
    const k = `${c.payer}|${c.claimId}`;
    const first = seenId.get(k);
    if (first) {
      dups.push({ key: c.key, duplicateOf: first, rule: 'same-claim-id', evidence: `claim id ${c.claimId}` });
      isDup.add(c.key);
    } else seenId.set(k, c.key);
  }
  const groups = new Map<string, Claim[]>();
  for (const c of sorted) {
    if (isDup.has(c.key)) continue;
    const fp = fingerprint(c, golden(c.memberKey));
    if (fp) groups.set(fp, [...(groups.get(fp) ?? []), c]);
  }
  // Decided per whole group, so the result doesn't depend on order. The fingerprint is a
  // fallback: if any payer in the group issued two different claim ids for it, it isn't
  // unique that day (e.g. a repeat visit) and nothing in the group merges on it.
  for (const [fp, group] of groups) {
    if (group.length < 2) continue;
    const ambiguous = group.some((x) => x.claimId && group.some((y) => y.payer === x.payer && y.claimId && y.claimId !== x.claimId));
    if (ambiguous) continue;
    for (const c of group.slice(1)) dups.push({ key: c.key, duplicateOf: group[0]!.key, rule: 'fingerprint', evidence: fp.split('~').slice(1).join(' · ') });
  }
  return dups;
}

/** HL7 Confidentiality is one ranked scale, not a set of tags. */
const CONFIDENTIALITY = ['U', 'L', 'M', 'N', 'R', 'V'];

/**
 * Survivorship for sensitivity: the surviving copy of a duplicate set keeps the most
 * restrictive confidentiality code any copy had, plus every other sensitivity or handling
 * label (e.g. 42CFRPart2), so a restricted claim can't become "normal" because a
 * less-labeled twin happened to sort first.
 */
export function inheritSecurity(claims: Claim[], dups: Duplicate[]): Fix[] {
  const byKey = new Map(claims.map((c) => [c.key, c]));
  const fixes: Fix[] = [];
  const rank = (codes: string[]) => Math.max(-1, ...codes.map((c) => CONFIDENTIALITY.indexOf(c)));
  for (const d of dups) {
    const survivor = byKey.get(d.duplicateOf);
    const dup = byKey.get(d.key);
    if (!survivor || !dup) continue;
    const conf = Math.max(rank(survivor.security), rank(dup.security));
    const tags = [...new Set([...survivor.security, ...dup.security].filter((c) => !CONFIDENTIALITY.includes(c)))];
    const next = [...(conf >= 0 ? [CONFIDENTIALITY[conf]!] : []), ...tags].sort();
    if (next.join(',') === survivor.security.join(',')) continue;
    fixes.push({ key: survivor.key, rule: 'security-label-inherited', field: 'meta.security', from: `${survivor.security.join(',') || '(none)'} (duplicate ${d.key} had ${dup.security.join(',') || 'none'})`, to: next.join(',') });
    survivor.security = next;
  }
  return fixes;
}

