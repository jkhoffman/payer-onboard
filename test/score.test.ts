// Mutation tests for the scorecard: plant one known defect in otherwise clean FHIR, run the
// real normalizer and store, and check that the independent observers catch it, that the
// right rule gets the credit, and that an unlogged change is caught by reconciliation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writeStore } from '../src/store.ts';
import { scorePayers } from '../src/score.ts';
import { dedupeClaims, normalizeClaim, type Fix } from '../src/normalize.ts';
import type { Resource } from '../src/fhir-paths.ts';

const ADJ = 'http://terminology.hl7.org/CodeSystem/adjudication';
const PROFILE = 'http://hl7.org/fhir/us/carin-bb/StructureDefinition/C4BB-ExplanationOfBenefit-Professional-NonClinician';
const cfg = { codeSystemAliases: { 'https://bluebutton.cms.gov/resources/codesystem/hcpcs': 'http://www.ama-assn.org/go/cpt' }, amountAliases: { billed: ['https://bluebutton.cms.gov/resources/variables/line_sbmtd_chrg_amt'] }, specProfiles: [PROFILE] };
const observe = () => ({ codeSystemAliases: cfg.codeSystemAliases, specProfiles: cfg.specProfiles });

function clean(id: string): Resource {
  return {
    resourceType: 'ExplanationOfBenefit',
    id,
    meta: { profile: [PROFILE] },
    status: 'active',
    identifier: [{ type: { coding: [{ code: 'uc' }] }, value: `UC-${id}` }],
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'professional' }] },
    patient: { reference: 'Patient/a' },
    billablePeriod: { start: '2025-01-02', end: '2025-01-02' },
    provider: { identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567893' } },
    diagnosis: [{ diagnosisCodeableConcept: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'E11.9' }] } }],
    item: [{ productOrService: { coding: [{ system: 'http://www.ama-assn.org/go/cpt', code: '99213' }] } }],
    total: [
      { category: { coding: [{ system: ADJ, code: 'submitted' }] }, amount: { value: 100 } },
      { category: { coding: [{ system: ADJ, code: 'benefit' }] }, amount: { value: 80 } },
    ],
  };
}

function run(resources: Resource[], tamper?: (fixes: Fix[]) => Fix[]) {
  const n = resources.map((r) => normalizeClaim(r, 'x', cfg));
  const claims = n.map((x) => x.claim);
  const duplicates = dedupeClaims(claims, () => 'x:Patient/a');
  const fixes = n.flatMap((x) => x.fixes);
  const path = join(mkdtempSync(join(tmpdir(), 'po-')), 't.db');
  const db = writeStore(path, {
    members: [{ key: 'x:Patient/a', payer: 'x', identifiers: [], golden: 'x:Patient/a', evidence: null }],
    claims: claims.map((c, i) => ({ ...c, goldenMember: 'x:Patient/a', raw: resources[i] })),
    duplicates,
    review: [],
    fixes: tamper ? tamper(fixes) : fixes,
    issues: n.flatMap((x) => x.issues),
  });
  return scorePayers(db, observe, '2026-11-20')[0]!;
}

const ok = (s: ReturnType<typeof run>) => {
  assert.deepEqual(s.reconciliation.unexplained, []);
  assert.deepEqual(s.reconciliation.regressions, []);
};

test('clean data scores 100 raw and normalized, with nothing attributed', () => {
  const s = run([clean('1'), clean('2')]);
  ok(s);
  assert.equal(s.raw.overall, 100);
  assert.equal(s.normalized.overall, 100);
  assert.deepEqual(s.gainedBy, {});
});

const PLANTED: Array<[string, (r: Resource) => void, string]> = [
  ['a timestamp in billablePeriod (legal FHIR, normalized to a day for consistency)', (r) => { r['billablePeriod'] = { start: '2025-01-02T10:00:00Z', end: '2025-01-02T10:00:00Z' }; }, 'date-to-day'],
  ['an adjudication category with no system', (r) => { (r['total'] as Array<{ category: { coding: Array<{ system?: string }> } }>)[1]!.category.coding[0]!.system = undefined; }, 'adjudication-system-restored'],
  ['an ICD-10 code repeated under the loose system', (r) => { (r['diagnosis'] as Array<{ diagnosisCodeableConcept: { coding: object[] } }>)[0]!.diagnosisCodeableConcept.coding.push({ system: 'http://hl7.org/fhir/sid/icd-10', code: 'E11.9' }); }, 'duplicate-coding'],
  ['a vendor spelling of a code system', (r) => { (r['item'] as Array<{ productOrService: { coding: Array<{ system: string }> } }>)[0]!.productOrService.coding[0]!.system = 'https://bluebutton.cms.gov/resources/codesystem/hcpcs'; }, 'vendor-code-system-alias'],
  ['billed only under a vendor amount code', (r) => { (r['total'] as Array<{ category: { coding: Array<{ system: string; code: string }> } }>)[0]!.category.coding[0] = { system: 'https://bluebutton.cms.gov/resources/codesystem/adjudication', code: 'https://bluebutton.cms.gov/resources/variables/line_sbmtd_chrg_amt' }; }, 'vendor-amount-alias'],
];

for (const [what, plant, rule] of PLANTED) {
  test(`planted defect: ${what} lowers raw, is fixed, and is credited to ${rule}`, () => {
    const bad = clean('1');
    plant(bad);
    const s = run([bad, clean('2')]);
    ok(s);
    assert.ok(s.raw.overall < 100, 'raw observer must see the defect');
    assert.equal(s.normalized.overall, 100);
    assert.ok(s.gainedBy[rule]! > 0, `credited to ${rule}: ${JSON.stringify(s.gainedBy)}`);
    assert.ok(Math.abs(Object.values(s.gainedBy).reduce((a, b) => a + b, 0) - (s.normalized.overall - s.raw.overall)) < 0.11);
  });
}

test('an unfixable defect scores the same before and after', () => {
  const bad = clean('1');
  bad['identifier'] = [];
  const other = { ...clean('2'), billablePeriod: { start: '2025-03-04', end: '2025-03-04' } }; // a different visit, so no fingerprint match
  const s = run([bad, other]);
  ok(s);
  assert.equal(s.raw.overall, s.normalized.overall);
  assert.ok(s.raw.overall < 100);
});

test('a fix the normalizer made but did not log is caught by reconciliation', () => {
  const bad = clean('1');
  bad['billablePeriod'] = { start: '2025-01-02T10:00:00Z', end: '2025-01-02T10:00:00Z' };
  const s = run([bad, clean('2')], (fixes) => fixes.filter((f) => f.rule !== 'date-to-day'));
  assert.deepEqual(s.reconciliation.unexplained, [{ key: 'x:1', check: 'dates-are-dates' }]);
});

test('a duplicate is fixed by dedupe', () => {
  const s = run([clean('1'), { ...clean('2'), identifier: [{ type: { coding: [{ code: 'uc' }] }, value: 'UC-1' }] }]);
  ok(s);
  assert.equal(s.raw.dimensions.Uniqueness, 50);
  assert.equal(s.normalized.dimensions.Uniqueness, 100);
  assert.ok(s.gainedBy['dedupe:same-claim-id']! > 0);
});
