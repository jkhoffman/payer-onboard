import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { discover, failingGaps, rediscover } from '../src/discover.ts';
import { ROOT, loadSpec, loadVendors, readJson } from '../src/io.ts';
import { resolve } from '../src/layers.ts';
import type { CapabilityStatement, SmartConfiguration } from '../src/types.ts';

const spec = loadSpec();
const vendors = loadVendors();
const fixture = (name: string) => readJson<CapabilityStatement>(join(ROOT, 'fixtures/metadata', `${name}.json`));

function run(id: string, smart: SmartConfiguration | null = null) {
  return discover({ id, name: id, baseUrl: `https://example.test/${id}/`, capability: fixture(id), smart, spec, vendors, now: new Date(0) });
}

test('spec layer carries the IG SHALL search params for ExplanationOfBenefit', () => {
  const eob = spec.resources['ExplanationOfBenefit']!;
  assert.equal(eob.expectation, 'SHALL');
  for (const p of ['patient', '_lastUpdated', 'type', 'identifier', 'service-date', 'service-start-date', 'billable-period-start']) {
    assert.equal(eob.search[p], 'SHALL', p);
  }
});

test('CMS: SMART auth with PKCE, read-only, CARIN search gaps listed', () => {
  const smart = readJson<SmartConfiguration>(join(ROOT, 'fixtures/metadata/cms.smart-configuration.json'));
  const p = run('cms', smart);
  assert.equal(p.discovered.vendor, 'cms-bfd');
  assert.equal(p.auth.mode, 'smart-app-launch');
  assert.ok(p.auth.mode === 'smart-app-launch' && p.auth.pkce);
  assert.equal(p.discovered.writeEnabled, false);
  const eobSearchGaps = failingGaps(p).filter((g) => g.resource === 'ExplanationOfBenefit' && g.kind === 'search').map((g) => g.name);
  assert.deepEqual(eobSearchGaps.sort(), ['billable-period-start', 'identifier', 'service-start-date']);
});

test('a missing _id search is an equivalent, not a failure, when read is supported', () => {
  const smart = readJson<SmartConfiguration>(join(ROOT, 'fixtures/metadata/cms.smart-configuration.json'));
  const p = run('cms', smart);
  const idGaps = p.gaps.filter((g) => g.name === '_id');
  assert.ok(idGaps.length > 0);
  assert.ok(idGaps.every((g) => g.equivalent?.includes('(read)')));
  assert.ok(failingGaps(p).every((g) => g.name !== '_id'));
});

test('rediscovery keeps hand-written overrides and reports drift', () => {
  const previous = run('hapi');
  previous.overrides = { rateLimit: { requestsPerSecond: 1 } };
  previous.gaps = previous.gaps.filter((g) => g.name !== 'type');
  const { layer, changes } = rediscover(previous, run('hapi'));
  assert.deepEqual(layer.overrides, { rateLimit: { requestsPerSecond: 1 } });
  assert.ok(changes.includes('new gap ExplanationOfBenefit.search:type'));
  assert.ok(changes.some((c) => c.startsWith('kept overrides')));
});

test('spec layer labels its guessed defaults as assumptions', () => {
  assert.match(spec.assumptions['rateLimit.requestsPerSecond']!, /guess/i);
});

test('no server declares CARIN profiles, even CMS whose data is CARIN-profiled', () => {
  for (const id of ['cms', 'hapi', 'firely']) assert.equal(run(id).discovered.declaresSpecProfiles, false, id);
});

test('open test servers: no auth, accept writes, vendor matched', () => {
  for (const [id, vendor] of [['hapi', 'hapi'], ['firely', 'firely']] as const) {
    const p = run(id);
    assert.equal(p.auth.mode, 'none');
    assert.equal(p.discovered.writeEnabled, true);
    assert.equal(p.discovered.vendor, vendor);
  }
});

test('layers resolve leaf by leaf and record provenance', () => {
  const p = run('hapi');
  p.overrides = { rateLimit: { requestsPerSecond: 1 } };
  const eff = resolve(spec, vendors.find((v) => v.vendor.id === 'hapi')!, p);
  assert.equal(eff.baseUrl, 'https://example.test/hapi');
  assert.equal(eff.rateLimit.requestsPerSecond, 1);
  assert.equal(eff.provenance['rateLimit.requestsPerSecond'], 'override');
  assert.equal(eff.rateLimit.burst, 4);
  assert.equal(eff.provenance['rateLimit.burst'], 'spec');
  assert.equal(eff.provenance['baseUrl'], 'payer');
});

test('explain paths survive keys that contain dots (code-system URLs)', () => {
  const vendor = { vendor: { id: 'v', match: { softwareName: '.' } }, normalize: { codeSystemAliases: { 'https://x.test/hcpcs': 'https://canonical.test/hcpcs' }, amountAliases: {} } } as unknown as Parameters<typeof resolve>[1];
  const eff = resolve(loadSpec(), vendor, { payer: { id: 'p', name: 'p', baseUrl: 'https://p.test' } } as unknown as Parameters<typeof resolve>[2]);
  const key = 'normalize.codeSystemAliases[https://x.test/hcpcs]';
  assert.equal(eff.provenance[key], 'vendor');
  assert.equal(eff.provenancePaths[key]!.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], eff), 'https://canonical.test/hcpcs');
});
