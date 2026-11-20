import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PayerHttp, TokenBucket, type Clock } from '../src/http.ts';
import { checkSearches, suggestOverrides, type Recording } from '../src/probe.ts';
import { scrubRecording, syntheticMarker } from '../src/scrub.ts';
import type { Effective } from '../src/layers.ts';
import type { PayerLayer, SpecLayer } from '../src/types.ts';
import type { Resource } from '../src/fhir-paths.ts';

function fakeClock(): Clock & { slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return { slept, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } };
}

const eob = (id: string, type: string, start: string): Resource => ({
  resourceType: 'ExplanationOfBenefit',
  id,
  patient: { reference: `Patient/p-${id}` },
  type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: type }] },
  billablePeriod: { start, end: start },
  meta: { lastUpdated: `${start}T00:00:00Z` },
});

const CLAIMS = [eob('1', 'professional', '2024-01-01'), eob('2', 'pharmacy', '2024-06-01'), eob('3', 'professional', '2025-01-01')];
const bundle = (rs: Resource[]) => new Response(JSON.stringify({ resourceType: 'Bundle', entry: rs.map((resource) => ({ resource })) }), { status: 200 });

/** A server that applies `type` correctly, or one that ignores it and returns everything. */
function server(honorsType: boolean): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const raw = url.searchParams.get('type');
    if (raw === null) return bundle(CLAIMS);
    const type = raw.split('|').pop();
    return bundle(honorsType ? CLAIMS.filter((c) => (c['type'] as { coding: { code: string }[] }).coding[0]!.code === type) : CLAIMS);
  }) as typeof fetch;
}

const spec = { resources: { ExplanationOfBenefit: { expectation: 'SHALL', interactions: {}, search: { type: 'SHALL' }, profiles: [] } } } as unknown as SpecLayer;
const payer = { resources: { ExplanationOfBenefit: { search: [], interactions: [], declaredProfiles: [] } } } as unknown as PayerLayer;
const eff = { baseUrl: 'https://payer.test/fhir', probe: { searchCheckCount: 20 } } as unknown as Effective;
const rec: Recording = { ExplanationOfBenefit: CLAIMS, Patient: [], Coverage: [] };
const http = (f: typeof fetch) => new PayerHttp({ rateLimit: { requestsPerSecond: 100, burst: 100 }, retry: { maxAttempts: 1, baseDelayMs: 1 }, fetchImpl: f, clock: fakeClock() });

test('a server that silently ignores a filter is caught by the negative control', async () => {
  const [check] = await checkSearches(http(server(false)), eff, payer, spec, rec);
  assert.equal(check!.verdict, 'ignored');
  assert.match(check!.detail, /negative control/);
});

test('a server that applies the filter is honored', async () => {
  const [check] = await checkSearches(http(server(true)), eff, payer, spec, rec);
  assert.equal(check!.verdict, 'honored');
});

test('a 400 on the filter is reported as rejected', async () => {
  const f = (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch;
  const [check] = await checkSearches(http(f), eff, payer, spec, rec);
  assert.equal(check!.verdict, 'rejected');
});

test('without live access every search is untested, never guessed', async () => {
  const checks = await checkSearches(null, eff, payer, spec, rec);
  assert.ok(checks.every((c) => c.verdict === 'untested'));
});

test('token bucket allows the burst, then paces to the rate', async () => {
  const clock = fakeClock();
  const bucket = new TokenBucket(2, 3, clock);
  for (let i = 0; i < 5; i++) await bucket.take();
  assert.equal(clock.slept.reduce((a, b) => a + b, 0), 1000); // 3 free, then 2 more at 2/s
});

test('429 is retried after the Retry-After delay and counted', async () => {
  let calls = 0;
  const f = (async () => (++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '7' } }) : bundle([]))) as unknown as typeof fetch;
  const clock = fakeClock();
  const h = new PayerHttp({ rateLimit: { requestsPerSecond: 100, burst: 100 }, retry: { maxAttempts: 3, baseDelayMs: 1 }, fetchImpl: f, clock });
  const { status } = await h.get('https://payer.test/x');
  assert.equal(status, 200);
  assert.equal(h.stats.throttled, 1);
  assert.equal(h.stats.retries, 1);
  assert.ok(clock.slept.includes(7000));
});

test('when the spec form is rejected, a working variant is found and suggested as config', async () => {
  // Like CMS: patient=Patient/x is refused, patient=x works.
  const f = (async (input: string | URL | Request) => {
    const q = new URL(String(input)).searchParams.get('patient') ?? '';
    if (q.startsWith('Patient/')) return new Response('{}', { status: 403 });
    return bundle(CLAIMS.filter((c) => (c['patient'] as { reference: string }).reference === `Patient/${q}`));
  }) as unknown as typeof fetch;
  const pSpec = { resources: { ExplanationOfBenefit: { expectation: 'SHALL', interactions: {}, search: { patient: 'SHALL' }, profiles: [] } } } as unknown as SpecLayer;
  const checks = await checkSearches(http(f), eff, payer, pSpec, rec);
  assert.equal(checks[0]!.verdict, 'honored');
  assert.equal(checks[0]!.variant, 'bare-id');
  assert.deepEqual(checks[0]!.tried, ['spec=rejected', 'bare-id=honored']);
  assert.deepEqual(suggestOverrides(checks), { searchVariants: { ExplanationOfBenefit: { patient: 'bare-id' } } });
});

test('an ignored _lastUpdated means full sync; other ignored filters move client-side', () => {
  const s = suggestOverrides([
    { param: '_lastUpdated', claimed: true, verdict: 'ignored', detail: '' },
    { param: 'type', claimed: false, verdict: 'ignored', detail: '' },
    { param: 'patient', claimed: true, verdict: 'honored', detail: '' },
  ]);
  assert.deepEqual(s, { sync: { strategy: 'full' }, clientSideFilter: ['type'] });
});

test('patients without a synthetic marker are scrubbed; marked ones are untouched', () => {
  const real = { resourceType: 'Patient', id: '97920', name: [{ family: 'Gonzalez', given: ['Kimberly'] }], birthDate: '1980-02-03', address: [{ city: 'X' }], identifier: [{ system: 'urn:mrn', value: '12345' }] };
  const synth = { resourceType: 'Patient', id: '-10000010254618', name: [{ family: 'Greenfelder433', given: ['Chi716'] }] };
  const { rec: out, count } = scrubRecording({ ExplanationOfBenefit: [], Coverage: [], Patient: [real, synth] });
  assert.equal(count, 1);
  const s = out.Patient[0]!;
  assert.deepEqual(s['name'], [{ family: 'Scrubbed', given: ['Patient'] }]);
  assert.equal(s['address'], undefined);
  assert.equal(s['birthDate'], '1980');
  assert.match((s['identifier'] as { value: string }[])[0]!.value, /^sha256:/);
  assert.equal(out.Patient[1], synth);
  assert.equal(syntheticMarker(synth), 'negative id (CMS synthetic convention)');
});

/** F2: a server that filters correctly but errors on the impossible value used as the negative control. */
function strictServer(total: boolean, filters: boolean): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const type = url.searchParams.get('type')?.split('|').pop();
    if (type?.startsWith('payer-onboard-no-such')) return new Response('{}', { status: 400 });
    const rs = type && filters ? CLAIMS.filter((c) => (c['type'] as { coding: { code: string }[] }).coding[0]!.code === type) : CLAIMS;
    const page = rs.filter((c) => !type || (c['type'] as { coding: { code: string }[] }).coding[0]!.code === type); // the page happens to match
    return new Response(JSON.stringify({ resourceType: 'Bundle', ...(total ? { total: rs.length } : {}), entry: page.map((resource) => ({ resource })) }), { status: 200 });
  }) as typeof fetch;
}

test('an erroring negative control is never read as "returned 0"', async () => {
  const [check] = await checkSearches(http(strictServer(false, true)), eff, payer, spec, rec);
  assert.equal(check!.verdict, 'unverified');
  assert.match(check!.detail, /HTTP 400/);
});

test('when the negative control errors, a server total below the baseline proves the filter', async () => {
  const [check] = await checkSearches(http(strictServer(true, true)), eff, payer, spec, rec);
  assert.equal(check!.verdict, 'honored');
  assert.match(check!.detail, /total fell from 3 to 2/);
});

test('when the negative control errors and the total does not move, the filter stays unverified', async () => {
  const [check] = await checkSearches(http(strictServer(true, false)), eff, payer, spec, rec);
  assert.equal(check!.verdict, 'unverified');
});

test('a 401 during search checks stops the probe instead of recording "rejected"', async () => {
  const f = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(checkSearches(http(f), eff, payer, spec, rec), /401/);
});

test('credentials are sent only to the payer origin', async () => {
  const seen: Array<[string, string | null]> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push([String(input), new Headers(init?.headers).get('authorization')]);
    return bundle([]);
  }) as unknown as typeof fetch;
  const h = http(f);
  h.origin = 'https://payer.test';
  h.headers = { authorization: 'Bearer secret' };
  await h.get('https://payer.test/fhir/x');
  await h.get('https://elsewhere.test/fhir/x');
  assert.deepEqual(seen.map(([, a]) => a), ['Bearer secret', null]);
});

test('scrubbing a member reaches their Coverage and claims, and keeps only allowlisted Patient fields', () => {
  const p: Resource = {
    resourceType: 'Patient', id: 'real-1', name: [{ family: 'Smith', given: ['Ann'] }], birthDate: '1970-04-02', gender: 'female',
    identifier: [{ system: 'urn:mrn', value: 'MRN-42' }],
    extension: [{ url: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race' }],
    maritalStatus: { text: 'Married' }, generalPractitioner: [{ display: 'Dr Who' }],
  };
  const cov: Resource = { resourceType: 'Coverage', id: 'c1', beneficiary: { reference: 'Patient/real-1', display: 'Ann Smith' }, subscriberId: 'SUB-9', class: [{ value: 'GRP-1', name: 'Acme Group' }] };
  const claim: Resource = { resourceType: 'ExplanationOfBenefit', id: 'e1', patient: { reference: 'Patient/real-1/_history/3', display: 'Ann Smith' }, text: { div: '<div>Ann Smith</div>' }, total: [] };
  const other: Resource = { resourceType: 'ExplanationOfBenefit', id: 'e2', patient: { reference: 'Patient/someone-else', display: 'Kept' } };
  const { rec, count } = scrubRecording({ Patient: [p], Coverage: [cov], ExplanationOfBenefit: [claim, other] });
  assert.equal(count, 1);
  const out = JSON.stringify(rec);
  for (const leak of ['Smith', 'MRN-42', 'SUB-9', 'GRP-1', 'Acme', 'Married', 'Dr Who', 'us-core-race', '1970-04']) assert.ok(!out.includes(leak), `leaked ${leak}`);
  assert.equal(rec.Patient[0]!['birthDate'], '1970');
  assert.equal((rec.ExplanationOfBenefit[0]!['patient'] as { reference: string }).reference, 'Patient/real-1/_history/3');
  assert.equal((rec.ExplanationOfBenefit[1]!['patient'] as { display?: string }).display, undefined); // unrecorded member: fail closed
});

test('the scrub fails closed: claims whose patient is not a recorded synthetic patient are scrubbed', () => {
  const synth: Resource = { resourceType: 'Patient', id: 's1', meta: { tag: [{ code: 'HTEST' }] } as never, name: [{ family: 'Test' }] };
  const mk = (id: string, patient: object): Resource => ({ resourceType: 'ExplanationOfBenefit', id, patient, payee: { party: { reference: 'Patient/x', display: 'Jane Roe' } },
    item: [{ locationAddress: { line: ['1 Home St'] }, productOrService: { coding: [{ system: 's', code: 'c', display: 'Office visit' }] } }] });
  const claims = [
    mk('unfetched', { reference: 'Patient/number-51', display: 'Jane Roe' }),
    mk('contained', { reference: '#p', display: 'Jane Roe' }),
    mk('by-identifier', { identifier: { system: 'urn:mrn', value: 'MRN-7' }, display: 'Jane Roe' }),
    mk('synthetic', { reference: 'Patient/s1', display: 'Test Patient' }),
  ];
  const { rec, unresolved } = scrubRecording({ Patient: [synth], Coverage: [], ExplanationOfBenefit: claims });
  assert.equal(unresolved, 3);
  const out = JSON.stringify(rec.ExplanationOfBenefit.slice(0, 3));
  for (const leak of ['Jane Roe', 'MRN-7', '1 Home St']) assert.ok(!out.includes(leak), `leaked ${leak}`);
  assert.ok(out.includes('Office visit'), 'coding displays are kept');
  assert.equal((rec.ExplanationOfBenefit[3]!['patient'] as { display: string }).display, 'Test Patient'); // known synthetic: untouched
});

test('scrubbing keeps a contained provider, so the NPI survives', () => {
  const claim: Resource = { resourceType: 'ExplanationOfBenefit', id: 'e', patient: { reference: 'Patient/gone' }, provider: { reference: '#org' },
    contained: [{ resourceType: 'Organization', id: 'org', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567893' }] }, { resourceType: 'Patient', id: 'p', name: [{ family: 'Roe' }] }] };
  const { rec } = scrubRecording({ Patient: [], Coverage: [], ExplanationOfBenefit: [claim] });
  const contained = rec.ExplanationOfBenefit[0]!['contained'] as Resource[];
  assert.deepEqual(contained.map((c) => c.resourceType), ['Organization']);
});
