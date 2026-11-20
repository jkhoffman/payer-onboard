import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeClaims, linkMembers, normalizeClaim, reviewCandidates, validNpi, type NormalizeConfig } from '../src/normalize.ts';
import type { Resource } from '../src/fhir-paths.ts';

const cfg: NormalizeConfig = {
  codeSystemAliases: { 'https://payer.example/hcpcs': 'https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets' },
  amountAliases: { billed: ['https://payer.example/total-charge'] },
  specProfiles: ['http://hl7.org/fhir/us/carin-bb/StructureDefinition/C4BB-ExplanationOfBenefit-Professional-NonClinician'],
};

const eob = (id: string, patient: string, over: Record<string, unknown> = {}): Resource => ({
  resourceType: 'ExplanationOfBenefit',
  id,
  patient: { reference: `Patient/${patient}` },
  type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
  billablePeriod: { start: '2026-11-13', end: '2026-11-13' },
  provider: { identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567893' } },
  item: [{ productOrService: { coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: '99283' }] } }],
  total: [{ category: { coding: [{ code: 'submitted' }] }, amount: { value: 1500 } }],
  ...over,
});

test('NPI check digit', () => {
  assert.equal(validNpi('1234567893'), true);
  assert.equal(validNpi('1234567890'), false);
  assert.equal(validNpi('Prac-00001'), false);
});

test('each change is a named fix; problems that cannot be fixed are issues, never invented', () => {
  const { claim, fixes, issues } = normalizeClaim(
    eob('1', 'p', {
      billablePeriod: { start: '2026-11-13T09:00:00Z' },
      diagnosis: [{ diagnosisCodeableConcept: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'E11.9' }, { system: 'http://hl7.org/fhir/sid/icd-10', code: 'E11.9' }] } }],
      item: [{ productOrService: { coding: [{ system: 'https://payer.example/hcpcs', code: 'G0008' }, { system: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason', code: 'not-applicable' }] } }],
      total: [{ category: { coding: [{ code: 'https://payer.example/total-charge' }] }, amount: { value: 42 } }],
    }),
    'acme',
    cfg,
  );
  const rules = fixes.map((f) => f.rule).sort();
  assert.deepEqual(rules, ['date-to-day', 'duplicate-coding', 'vendor-amount-alias', 'vendor-code-system-alias', 'code-system-alias'].sort());
  assert.equal(claim.serviceStart, '2026-11-13');
  assert.deepEqual(claim.diagnoses, [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'E11.9' }]);
  assert.deepEqual(claim.procedures, [{ system: 'https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets', code: 'G0008' }]);
  assert.equal(claim.billed, 42);
  assert.ok(issues.some((i) => i.rule === 'no-claim-id'));
  assert.ok(issues.some((i) => i.rule === 'no-carin-profile'));
});

test('an invalid NPI is reported and not used', () => {
  const { claim, issues } = normalizeClaim(eob('1', 'p', { provider: { identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: '2000000817' } } }), 'acme', cfg);
  assert.equal(claim.billingNpi, null);
  assert.ok(issues.some((i) => i.rule === 'invalid-npi'));
});

test('members link only on a shared identifier, never on similar names', () => {
  const links = linkMembers([
    { key: 'x:Patient/a', payer: 'x', identifiers: [{ system: 'urn:mpi', value: 'M1' }, { system: 'urn:a/mrn', value: 'A1' }] },
    { key: 'x:Patient/b', payer: 'x', identifiers: [{ system: 'urn:mpi', value: 'M1' }, { system: 'urn:b/mrn', value: 'B1' }] },
    { key: 'x:Patient/c', payer: 'x', identifiers: [{ system: 'urn:c/mrn', value: 'M1' }] }, // same value, different system
  ]);
  assert.equal(links.get('x:Patient/b')!.golden, 'x:Patient/a');
  assert.equal(links.get('x:Patient/b')!.evidence, 'urn:mpi|M1');
  assert.equal(links.get('x:Patient/c')!.golden, 'x:Patient/c');
});

test('the same claim from two linked sources is a fingerprint duplicate', () => {
  const a = normalizeClaim(eob('a1', 'a'), 'x', cfg).claim;
  const b = normalizeClaim(eob('b1', 'b'), 'x', cfg).claim;
  const dups = dedupeClaims([a, b], (k) => (k === 'x:Patient/b' ? 'x:Patient/a' : k));
  assert.deepEqual(dups.map((d) => [d.key, d.duplicateOf, d.rule]), [['x:b1', 'x:a1', 'fingerprint']]);
});

test('no fingerprint merge without a valid NPI and a procedure code', () => {
  const noCodes = (id: string) => normalizeClaim(eob(id, 'a', { item: [] }), 'x', cfg).claim;
  assert.deepEqual(dedupeClaims([noCodes('1'), noCodes('2')], (k) => k), []);
  const badNpi = (id: string) => normalizeClaim(eob(id, 'a', { provider: { identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: 'Prac-00001' } } }), 'x', cfg).claim;
  assert.deepEqual(dedupeClaims([badNpi('1'), badNpi('2')], (k) => k), []);
});

test('same payer + same CARIN claim id is a duplicate even with different resource ids', () => {
  const withId = (id: string) => normalizeClaim(eob(id, 'a', { identifier: [{ type: { coding: [{ code: 'uc' }] }, value: 'CLM-1' }] }), 'x', cfg).claim;
  const dups = dedupeClaims([withId('r1'), withId('r2')], (k) => k);
  assert.deepEqual(dups.map((d) => d.rule), ['same-claim-id']);
});

test('matches blocked only by an invalid NPI go to human review with reasons, never merged', () => {
  const bad = (id: string, patient: string) =>
    normalizeClaim(eob(id, patient, { provider: { identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: '2000000817' } }, total: [{ category: { coding: [{ code: 'submitted' }] }, amount: { value: 9999 } }] }), 'x', cfg).claim;
  const claims = [bad('a1', 'a'), bad('b1', 'b')];
  const golden = (k: string | null) => (k === 'x:Patient/b' ? 'x:Patient/a' : k);
  assert.deepEqual(dedupeClaims(claims, golden), []);
  const review = reviewCandidates(claims, golden, new Set());
  assert.equal(review.length, 1);
  assert.equal(review[0]!.candidateOf, 'x:a1');
  assert.ok(review[0]!.reasons.some((r) => r.includes('check digit')));
  assert.ok(review[0]!.reasons.some((r) => r.includes('sentinel')));
});

test('versioned and absolute references resolve to the resource, not the version', async () => {
  const { relativeRef } = await import('../src/fhir-paths.ts');
  assert.equal(relativeRef('Patient/123/_history/2'), 'Patient/123');
  assert.equal(relativeRef('https://x.test/r4/Patient/abc-1/_history/9'), 'Patient/abc-1');
  assert.equal(relativeRef('Patient/123'), 'Patient/123');
  assert.equal(relativeRef('#contained-1'), undefined);
});

test('two claims from one payer with different claim ids are never fingerprint-merged', async () => {
  const { dedupeClaims } = await import('../src/normalize.ts');
  const base = { payer: 'p', memberKey: 'p:Patient/a', type: 'professional', status: 'active', serviceStart: '2025-01-02', serviceEnd: '2025-01-02',
    billingNpi: '1234567893', providerIdRaw: '1234567893', diagnoses: [], procedures: [{ system: 's', code: '99213' }], billed: 100, paid: 80,
    carinProfile: true, amountCategoriesCoded: true, security: [] };
  const a = { ...base, key: 'p:1', sourceId: '1', claimId: 'UC-1' };
  const b = { ...base, key: 'p:2', sourceId: '2', claimId: 'UC-2' }; // a repeat visit, same day
  const c = { ...base, key: 'q:3', payer: 'q', sourceId: '3', claimId: 'Q-9' }; // the same claim from another source
  // Payer p issued two ids for one fingerprint, so the fingerprint is ambiguous that day: nothing merges on it.
  assert.deepEqual(dedupeClaims([a, b, c], () => 'person-1'), []);
  // Without the repeat visit, the same claim from another source does merge.
  assert.deepEqual(dedupeClaims([a, c], () => 'person-1').map((d) => [d.key, d.duplicateOf, d.rule]), [['q:3', 'p:1', 'fingerprint']]);
  // Review round 2's break case: a second payer's repeat visit must not vanish behind the first payer's claim.
  const a1 = { ...base, key: 'a:1', payer: 'a', sourceId: '1', claimId: 'A-1' };
  const b1 = { ...base, key: 'b:1', payer: 'b', sourceId: '1', claimId: 'B-1' };
  const b2 = { ...base, key: 'b:2', payer: 'b', sourceId: '2', claimId: 'B-2' };
  const got = dedupeClaims([a1, b1, b2], () => 'person-1');
  assert.deepEqual(got, [], 'which of b:1 / b:2 is a:1\'s twin is unknowable, so neither merges');
});

test('the surviving copy inherits every security label of its duplicates', async () => {
  const { inheritSecurity } = await import('../src/normalize.ts');
  type C = import('../src/normalize.ts').Claim;
  const survivor = { key: 'f:a', security: ['N'] } as never as C;
  const twin = { key: 'f:b', security: ['42CFRPart2', 'R'] } as never as C;
  const fixes = inheritSecurity([survivor, twin], [{ key: 'f:b', duplicateOf: 'f:a', rule: 'fingerprint', evidence: '' }]);
  assert.deepEqual(survivor.security, ['42CFRPart2', 'R']); // most restrictive confidentiality, plus the Part 2 tag
  assert.equal(fixes[0]!.rule, 'security-label-inherited');
  // A restricted survivor is never downgraded by a "normal" twin.
  const r = { key: 'f:c', security: ['R'] } as never as C;
  const n = { key: 'f:d', security: ['N'] } as never as C;
  assert.deepEqual(inheritSecurity([r, n], [{ key: 'f:d', duplicateOf: 'f:c', rule: 'fingerprint', evidence: '' }]), []);
  assert.deepEqual(r.security, ['R']);
});
