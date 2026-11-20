// Probe: fetch a payer's data through its effective config, record it, and test
// what the server *does* against what its CapabilityStatement *claims*.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  billablePeriod,
  coverageRefs,
  day,
  entries,
  identifiers,
  nextLink,
  patientRef,
  typeCoding,
  type Bundle,
  type Resource,
} from './fhir-paths.ts';
import type { HttpStats, PayerHttp } from './http.ts';
import type { Effective } from './layers.ts';
import type { PayerLayer, SpecLayer } from './types.ts';

export interface Recording {
  ExplanationOfBenefit: Resource[];
  Patient: Resource[];
  Coverage: Resource[];
  stoppedEarly?: string;
}

export type Verdict = 'honored' | 'unverified' | 'ignored' | 'rejected' | 'empty' | 'untested';

export interface SearchCheck {
  param: string;
  claimed: boolean;
  verdict: Verdict;
  detail: string;
  query?: string;
  /** Set when the server accepts only an alternative form, e.g. "bare-id". */
  variant?: string;
  /** Every form attempted, in order, with its verdict. */
  tried?: string[];
}

export interface ProbeReport {
  payer: string;
  source: 'live' | 'recorded-files';
  sourceNote?: string;
  recordedAt: string;
  counts: { ExplanationOfBenefit: number; Patient: number; Coverage: number };
  pages: number;
  http: HttpStats | null;
  profiles: { declared: boolean; eobTotal: number; eobWithSpecProfile: number };
  searchChecks: SearchCheck[];
  suggestions: string[];
  /** Config the evidence supports. Never applied automatically: `payer-onboard accept <id>` does that. */
  suggestedOverrides: SuggestedOverrides;
  scrubbedPatients?: number;
  scrubbedUnresolvedClaims?: number;
  stoppedEarly?: string;
}

export interface SuggestedOverrides {
  searchVariants?: Record<string, Record<string, string>>;
  sync?: { strategy: 'full' };
  clientSideFilter?: string[];
}

export function suggestOverrides(checks: SearchCheck[]): SuggestedOverrides {
  const out: SuggestedOverrides = {};
  for (const c of checks) {
    // A variant is suggested when it is the form the server accepts, even if a one-member
    // token can't prove it filters (unverified): the spec form already failed.
    if ((c.verdict === 'honored' || c.verdict === 'unverified') && c.variant) {
      out.searchVariants ??= { ExplanationOfBenefit: {} };
      out.searchVariants['ExplanationOfBenefit']![c.param] = c.variant;
    }
    if (c.verdict === 'ignored' || c.verdict === 'rejected' || c.verdict === 'empty') {
      // Without a working _lastUpdated there is no incremental sync: pull everything each time.
      if (c.param === '_lastUpdated') out.sync = { strategy: 'full' };
      else (out.clientSideFilter ??= []).push(c.param);
    }
  }
  return out;
}

// ---------- collection ----------

export async function collectLive(http: PayerHttp, eff: Effective): Promise<{ rec: Recording; pages: number }> {
  const rec: Recording = { ExplanationOfBenefit: [], Patient: [], Coverage: [] };
  const params = new URLSearchParams({ _count: String(eff.paging.pageSize), ...(eff.searchDefaults['ExplanationOfBenefit'] ?? {}) });
  let url: string | undefined = `${eff.baseUrl}/ExplanationOfBenefit?${params}`;
  let pages = 0;
  const seen = new Set<string>();
  while (url && rec.ExplanationOfBenefit.length < eff.probe.maxClaims) {
    const { status, body } = await http.get<Bundle>(url);
    if (!body) {
      rec.stoppedEarly = `page ${pages + 1} returned HTTP ${status}; data is partial`;
      break;
    }
    pages++;
    for (const r of entries(body)) {
      if (r.resourceType !== 'ExplanationOfBenefit') continue;
      // The same resource on two pages is a paging artifact, not a duplicate claim.
      if (r.id && seen.has(r.id)) continue;
      if (r.id) seen.add(r.id);
      rec.ExplanationOfBenefit.push(r);
    }
    url = nextLink(body);
  }
  rec.ExplanationOfBenefit = rec.ExplanationOfBenefit.slice(0, eff.probe.maxClaims);

  const patients = unique(rec.ExplanationOfBenefit.map(patientRef)).slice(0, eff.probe.maxPatients);
  for (const ref of patients) {
    const { body } = await http.get<Resource>(`${eff.baseUrl}/${ref}`);
    if (body) rec.Patient.push(body);
  }
  const coverages = unique(rec.ExplanationOfBenefit.flatMap(coverageRefs));
  for (const ref of coverages) {
    const { body } = await http.get<Resource>(`${eff.baseUrl}/${ref}`);
    if (body) rec.Coverage.push(body);
  }
  return { rec, pages };
}

export function collectFromFiles(paths: string[], root: string): Recording {
  const rec: Recording = { ExplanationOfBenefit: [], Patient: [], Coverage: [] };
  for (const p of paths) {
    const json = JSON.parse(readFileSync(isAbsolute(p) ? p : join(root, p), 'utf8')) as Resource | Bundle;
    const resources = json.resourceType === 'Bundle' ? entries(json as Bundle) : [json as Resource];
    for (const r of resources) {
      if (r.resourceType === 'ExplanationOfBenefit' || r.resourceType === 'Patient' || r.resourceType === 'Coverage') rec[r.resourceType].push(r);
    }
  }
  return rec;
}

// ---------- behavior checks ----------

/**
 * One way of writing a search. The spec form comes first; variants are the common
 * alternative forms payers actually accept. Each carries its own negative control:
 * a value that cannot match, so a server that drops the parameter is caught even
 * when its unfiltered first page happens to match.
 */
interface Form {
  variant: string | null; // null = the spec form
  query: string;
  negative: string;
  match: (r: Resource) => boolean;
}

type CheckDef = (rec: Resource[]) => Form[] | string;

const median = <T>(xs: T[]): T | undefined => [...xs].sort()[Math.floor(xs.length / 2)];
const CARIN_CLAIM_TYPE = 'http://terminology.hl7.org/CodeSystem/claim-type';
const NO_SUCH = 'payer-onboard-no-such-value';
type Coding = { system?: string; code?: string };
const typeCodings = (r: Resource): Coding[] => (r['type'] as { coding?: Coding[] } | undefined)?.coding ?? [];

const CHECKS: Record<string, CheckDef> = {
  patient(rec) {
    const ref = rec.map(patientRef).find(Boolean);
    if (!ref) return 'no patient reference in data';
    const match = (r: Resource) => patientRef(r) === ref;
    return [
      { variant: null, query: `patient=${ref}`, negative: `patient=Patient/${NO_SUCH}`, match },
      { variant: 'bare-id', query: `patient=${ref.split('/')[1]}`, negative: `patient=${NO_SUCH}`, match },
    ];
  },
  _lastUpdated(rec) {
    const t = median(rec.map((r) => r.meta?.lastUpdated).filter((x): x is string => Boolean(x)));
    if (!t) return 'no meta.lastUpdated in data';
    return [{ variant: null, query: `_lastUpdated=ge${encodeURIComponent(t)}`, negative: '_lastUpdated=ge2999-01-01', match: (r: Resource) => Date.parse(r.meta?.lastUpdated ?? '') >= Date.parse(t) }];
  },
  type(rec) {
    const forms: Form[] = [];
    const carin = rec.flatMap(typeCodings).find((c) => c.system === CARIN_CLAIM_TYPE && c.code);
    if (carin) {
      forms.push({
        variant: null,
        query: `type=${encodeURIComponent(`${CARIN_CLAIM_TYPE}|${carin.code}`)}`,
        negative: `type=${encodeURIComponent(`${CARIN_CLAIM_TYPE}|${NO_SUCH}`)}`,
        match: (r) => typeCodings(r).some((c) => c.system === CARIN_CLAIM_TYPE && c.code === carin.code),
      });
    }
    // Payer-specific code systems, searched by bare code (e.g. CMS accepts type=pde).
    const seen = new Set<string>();
    for (const c of rec.flatMap(typeCodings)) {
      if (!c.code || !c.system || c.system === CARIN_CLAIM_TYPE || seen.has(c.system)) continue;
      seen.add(c.system);
      const code = c.code;
      const system = c.system;
      forms.push({
        variant: `code-only:${system}`,
        query: `type=${encodeURIComponent(code.toLowerCase())}`,
        negative: `type=${NO_SUCH}`,
        match: (r) => typeCodings(r).some((x) => x.system === system && x.code?.toLowerCase() === code.toLowerCase()),
      });
    }
    return forms.length ? forms : 'no type coding in data';
  },
  identifier(rec) {
    const id = rec.flatMap(identifiers).find((i) => i.value);
    if (!id?.value) return 'no identifier in data';
    const match = (r: Resource) => identifiers(r).some((i) => i.value === id.value);
    const forms: Form[] = [];
    if (id.system) forms.push({ variant: null, query: `identifier=${encodeURIComponent(`${id.system}|${id.value}`)}`, negative: `identifier=${encodeURIComponent(`urn:payer-onboard|${NO_SUCH}`)}`, match });
    forms.push({ variant: id.system ? 'value-only' : null, query: `identifier=${encodeURIComponent(id.value)}`, negative: `identifier=${NO_SUCH}`, match });
    return forms;
  },
  'service-date'(rec) {
    const d = day(rec.map((r) => billablePeriod(r).start).find(Boolean));
    if (!d) return 'no billablePeriod in data';
    // A period overlapping the day satisfies both eq (single-day claims) and ge&le; we test overlap.
    const match = (r: Resource) => servicePeriods(r).some((p) => p.start <= d && d <= p.end);
    return [
      { variant: null, query: `service-date=${d}`, negative: 'service-date=1900-01-01', match },
      // Some servers reject an unprefixed date; ge+le bounds the same day (overlap semantics).
      { variant: 'prefixed-range', query: `service-date=ge${d}&service-date=le${d}`, negative: 'service-date=ge2999-01-01', match },
    ];
  },
  'service-start-date': startDateCheck('service-start-date'),
  'billable-period-start': startDateCheck('billable-period-start'),
};

function startDateCheck(param: string): CheckDef {
  return (rec) => {
    const d = median(rec.map((r) => day(billablePeriod(r).start)).filter((x): x is string => Boolean(x)));
    if (!d) return 'no billablePeriod in data';
    const field = param === 'billable-period-start' ? (r: Resource) => [day(billablePeriod(r).start) ?? ''] : (r: Resource) => servicePeriods(r).map((p) => p.start);
    return [{ variant: null, query: `${param}=ge${d}`, negative: `${param}=ge2999-01-01`, match: (r: Resource) => field(r).some((x) => x >= d) }];
  };
}

const eobs = (b: Bundle) => entries(b).filter((r) => r.resourceType === 'ExplanationOfBenefit');

/** Service dates as CARIN 2.2.0 defines them: billablePeriod plus item.servicedDate / servicedPeriod. */
function servicePeriods(r: Resource): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  const bp = billablePeriod(r);
  if (bp.start) out.push({ start: day(bp.start)!, end: day(bp.end) ?? day(bp.start)! });
  for (const it of (r['item'] as Array<{ servicedDate?: string; servicedPeriod?: { start?: string; end?: string } }> | undefined) ?? []) {
    if (it.servicedDate) out.push({ start: day(it.servicedDate)!, end: day(it.servicedDate)! });
    if (it.servicedPeriod?.start) out.push({ start: day(it.servicedPeriod.start)!, end: day(it.servicedPeriod.end) ?? day(it.servicedPeriod.start)! });
  }
  return out;
}

type Search = (q: string) => Promise<{ status: number; body: Bundle | null }>;

/**
 * Test one form: the positive query, then its negative control. A control that errors
 * proves nothing, so it is never read as "returned 0". When it errors, the server's own
 * Bundle.total is the fallback evidence: a filter that cuts the total from the unfiltered
 * baseline is applied; one that leaves it unchanged can't be told apart from no filter.
 */
async function tryForm(search: Search, f: Form, baselineTotal: () => Promise<number | null>): Promise<Omit<SearchCheck, 'param' | 'claimed'>> {
  const base = { query: f.query, ...(f.variant ? { variant: f.variant } : {}) };
  const pos = await search(f.query);
  if (pos.status === 401) throw new Error('HTTP 401 during search checks: the access token expired or was revoked; re-run auth');
  if (!pos.body) return { ...base, verdict: pos.status >= 400 && pos.status < 500 ? 'rejected' : 'untested', detail: `HTTP ${pos.status}` };
  const neg = await search(f.negative);
  if (neg.status === 401) throw new Error('HTTP 401 during search checks: the access token expired or was revoked; re-run auth');
  const negHits = neg.body ? eobs(neg.body).length : null;
  if (negHits) return { ...base, verdict: 'ignored', detail: `negative control (${f.negative}) returned ${negHits} claims; the filter is dropped` };
  const got = eobs(pos.body);
  const misses = got.filter((r) => !f.match(r)).length;
  if (got.length === 0) return { ...base, verdict: 'empty', detail: 'returned no claims, though recorded data has matches' };
  if (misses > 0) return { ...base, verdict: 'ignored', detail: `${misses}/${got.length} returned claims do not match the filter` };
  if (negHits === 0) return { ...base, verdict: 'honored', detail: `${got.length}/${got.length} match; negative control returned 0` };
  // The negative control errored, which proves nothing. Fall back to the server's own totals.
  const all = await baselineTotal();
  const t = pos.body.total;
  if (typeof t === 'number' && all !== null && t < all) {
    return { ...base, verdict: 'honored', detail: `${got.length}/${got.length} match; negative control returned HTTP ${neg.status}, but the server total fell from ${all} to ${t}` };
  }
  const why = typeof t === 'number' && all !== null ? `total unchanged (${t} of ${all})` : 'server reports no totals';
  return { ...base, verdict: 'unverified', detail: `${got.length}/${got.length} match, but negative control returned HTTP ${neg.status} and ${why}; cannot tell filtering from no filtering` };
}

const RANK: Record<Verdict, number> = { honored: 0, unverified: 1, ignored: 2, empty: 3, rejected: 4, untested: 5 };

export async function checkSearches(
  http: PayerHttp | null,
  eff: Effective,
  payer: PayerLayer,
  spec: SpecLayer,
  rec: Recording,
): Promise<SearchCheck[]> {
  const claimedParams = new Set(payer.resources['ExplanationOfBenefit']?.search ?? []);
  const required = Object.entries(spec.resources['ExplanationOfBenefit']?.search ?? {})
    .filter(([, e]) => e === 'SHALL')
    .map(([p]) => p)
    .filter((p) => p in CHECKS);

  const out: SearchCheck[] = [];
  let baseline: Promise<number | null> | undefined;
  for (const param of required) {
    const claimed = claimedParams.has(param);
    const forms = CHECKS[param]!(rec.ExplanationOfBenefit);
    if (typeof forms === 'string') {
      out.push({ param, claimed, verdict: 'untested', detail: forms });
      continue;
    }
    if (!http) {
      out.push({ param, claimed, verdict: 'untested', detail: 'recorded data only; live search needs an OAuth app', query: forms[0]!.query });
      continue;
    }
    const search = (q: string) => http.get<Bundle>(`${eff.baseUrl}/ExplanationOfBenefit?${q}&_count=${eff.probe.searchCheckCount}`);
    const baselineTotal = async () => {
      baseline ??= http.get<Bundle>(`${eff.baseUrl}/ExplanationOfBenefit?_count=1`).then((r) => (typeof r.body?.total === 'number' ? r.body.total : null));
      return baseline;
    };
    // Spec form first; fall through to variants only while nothing has been honored.
    let best: Omit<SearchCheck, 'param' | 'claimed'> | null = null;
    const tried: string[] = [];
    for (const f of forms) {
      const r = await tryForm(search, f, baselineTotal);
      tried.push(`${f.variant ?? 'spec'}=${r.verdict}`);
      if (!best || RANK[r.verdict] < RANK[best.verdict]) best = r;
      if (r.verdict === 'honored') break;
    }
    out.push({ param, claimed, ...best!, ...(tried.length > 1 ? { tried } : {}) });
  }
  return out;
}

// ---------- report ----------

export function profileStats(rec: Recording, spec: SpecLayer, payer: PayerLayer) {
  const specProfiles = new Set((spec.resources['ExplanationOfBenefit']?.profiles ?? []).map((p) => p.split('|')[0]));
  const eobWithSpecProfile = rec.ExplanationOfBenefit.filter((r) => (r.meta?.profile ?? []).some((p) => specProfiles.has(p.split('|')[0]))).length;
  return { declared: payer.discovered.declaresSpecProfiles, eobTotal: rec.ExplanationOfBenefit.length, eobWithSpecProfile };
}

export function suggestions(report: Omit<ProbeReport, 'suggestions' | 'suggestedOverrides'>, eff: Effective): string[] {
  const out: string[] = [];
  const p = report.profiles;
  if (!p.declared && p.eobWithSpecProfile > 0) out.push(`Data is CARIN-profiled (${p.eobWithSpecProfile}/${p.eobTotal} claims) although the CapabilityStatement doesn't say so: trust the data, not the claim.`);
  if (p.eobTotal > 0 && p.eobWithSpecProfile === 0) out.push('No claim carries a CARIN profile: expect generic FHIR and lower conformity scores.');
  for (const c of report.searchChecks) {
    if (c.verdict === 'ignored') out.push(`Server silently ignores ${c.param}${c.claimed ? ' even though it claims support' : ''}: never rely on it for filtering${c.param === '_lastUpdated' ? '; incremental sync would re-download everything' : ''}.`);
    if (c.verdict === 'honored' && c.variant) out.push(`${c.param} works only in an alternative form (${c.variant}); suggested as config.`);
    if (c.verdict === 'unverified') out.push(`${c.param} is accepted${c.variant ? ` (as ${c.variant}, suggested as config)` : ''} but its filtering is unverified: test with a token that sees more than one member.`);
    else if (c.verdict === 'honored' && !c.claimed) out.push(`${c.param} works although the CapabilityStatement omits it: safe to use.`);
    if (c.verdict === 'rejected' && c.claimed) out.push(`${c.param} is claimed but rejected (${c.detail}).`);
  }
  if (report.http && report.http.throttled > 0) {
    out.push(`Throttled ${report.http.throttled}x at ${eff.rateLimit.requestsPerSecond} req/s: set overrides.rateLimit.requestsPerSecond to ${Math.max(0.5, eff.rateLimit.requestsPerSecond / 2)}.`);
  } else if (report.http) {
    out.push(`No 429s in ${report.http.requests} requests at ${eff.rateLimit.requestsPerSecond} req/s; the default held (not proof of the payer's real limit).`);
  }
  return out;
}

function unique<T>(xs: (T | undefined)[]): T[] {
  return [...new Set(xs.filter((x): x is T => x !== undefined))];
}
