// PIQI-inspired data-quality scorecard (not a PIQI implementation). Each check is a
// yes/no per claim, observed twice by independent code: on the FHIR resource as the
// payer sent it ("raw", observe.ts) and on the canonical row after normalization.
// Neither observer reads the normalizer's fix log. Reconciliation then requires every
// fail-to-pass change to be explained by a logged fix rule allowed to make it, and
// reports any pass-to-fail regression. Points gained are attributed to those rules.
import type { DatabaseSync } from 'node:sqlite';
import { CHECK_IDS, RULES_FOR_CHECK, observeNormalized, observeRaw, type CheckId, type NormalizedRow, type ObserveConfig } from './observe.ts';
import type { Resource } from './fhir-paths.ts';

export const DIMENSIONS = ['Availability', 'Accuracy', 'Conformity', 'Plausibility', 'Uniqueness'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

type ScoredId = CheckId | 'unique';

export const CHECKS: Array<{ id: ScoredId; dimension: Dimension; label: string }> = [
  { id: 'service-date', dimension: 'Availability', label: 'Service date present' },
  { id: 'billed-amount', dimension: 'Availability', label: 'Billed amount present' },
  { id: 'claim-type', dimension: 'Availability', label: 'CARIN claim type present' },
  { id: 'claim-id', dimension: 'Availability', label: 'CARIN unique claim id present' },
  { id: 'provider', dimension: 'Availability', label: 'Billing provider NPI present' },
  { id: 'npi-valid', dimension: 'Accuracy', label: 'Provider NPI passes check digit' },
  { id: 'dates-are-dates', dimension: 'Accuracy', label: 'Service dates are day-precision (consistency)' },
  { id: 'billed-not-sentinel', dimension: 'Accuracy', label: 'Billed amount is not a sentinel (999…)' },
  { id: 'code-systems', dimension: 'Conformity', label: 'Codes use canonical code systems' },
  { id: 'no-duplicate-codings', dimension: 'Conformity', label: 'No code listed twice under two systems' },
  { id: 'adjudication-coded', dimension: 'Conformity', label: 'Amount categories carry a code system' },
  { id: 'carin-profile', dimension: 'Conformity', label: 'Claim declares a CARIN profile' },
  { id: 'period-order', dimension: 'Plausibility', label: 'Service end is not before start' },
  { id: 'not-future', dimension: 'Plausibility', label: 'Service date is not in the future' },
  { id: 'paid-le-billed', dimension: 'Plausibility', label: 'Paid does not exceed billed' },
  // Uniqueness (extension, like the Completeness extension in b.well's PIQI work): one claim, one row.
  { id: 'unique', dimension: 'Uniqueness', label: 'Claim is not a duplicate of another' },
];

export interface Reconciliation {
  /** Checks that went from fail to pass with no logged fix allowed to cause it. Must be empty. */
  unexplained: Array<{ key: string; check: string }>;
  /** Checks that went from pass to fail during normalization. Must be empty. */
  regressions: Array<{ key: string; check: string }>;
  /** Fix rules that were logged but moved no check (normalization for consistency, not quality). */
  noScoreEffect: Record<string, number>;
  /** Checks where only one side could be observed (e.g. an amount only readable through a vendor alias). */
  oneSided: Record<string, number>;
}

export interface CheckScore {
  id: ScoredId;
  dimension: Dimension;
  label: string;
  applicable: number;
  rawPass: number;
  normPass: number;
}

export interface PayerScore {
  payer: string;
  claims: number;
  raw: { overall: number; grade: string; dimensions: Record<Dimension, number> };
  normalized: { overall: number; grade: string; dimensions: Record<Dimension, number> };
  /** Overall points gained, by the fix rule that earned them. */
  gainedBy: Record<string, number>;
  checks: CheckScore[];
  reconciliation: Reconciliation;
}

export const grade = (s: number) => (s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 60 ? 'D' : 'F');
const round1 = (n: number) => Math.round(n * 10) / 10;

type Row = NormalizedRow & { key: string; payer: string; raw: string };

export function scorePayers(db: DatabaseSync, configFor: (payer: string) => Omit<ObserveConfig, 'today'>, today = new Date().toISOString().slice(0, 10)): PayerScore[] {
  const claims = db.prepare('SELECT * FROM claim ORDER BY payer, key').all() as unknown as Row[];
  const fixRules = new Map<string, Set<string>>();
  for (const f of db.prepare('SELECT key, rule FROM fix').all() as unknown as Array<{ key: string; rule: string }>) {
    fixRules.set(f.key, (fixRules.get(f.key) ?? new Set()).add(f.rule));
  }
  const dups = new Map((db.prepare('SELECT key, rule FROM duplicate').all() as unknown as Array<{ key: string; rule: string }>).map((d) => [d.key, d.rule]));
  const review = new Set((db.prepare('SELECT key FROM review').all() as unknown as Array<{ key: string }>).map((r) => r.key));

  const payers = [...new Set(claims.map((c) => c.payer))];
  return payers.map((payer) => {
    const cfg = { ...configFor(payer), today };
    const mine = claims.filter((c) => c.payer === payer);
    const stats = new Map(CHECKS.map((ch) => [ch.id, { applicable: 0, rawPass: 0, normPass: 0, fixedBy: new Map<string, number>() }]));
    const rec: Reconciliation = { unexplained: [], regressions: [], noScoreEffect: {}, oneSided: {} };
    for (const c of mine) {
      const rawObs = observeRaw(JSON.parse(c.raw) as Resource, cfg);
      const normObs = observeNormalized(c, cfg);
      const logged = fixRules.get(c.key) ?? new Set<string>();
      const used = new Set<string>();
      for (const id of CHECK_IDS) {
        let raw = rawObs[id];
        const norm = normObs[id] ?? raw;
        if (norm === null) continue;
        if (raw === null) {
          raw = norm; // not observable as sent; scored as unchanged, never as a gain
          rec.oneSided[id] = (rec.oneSided[id] ?? 0) + 1;
        }
        const s = stats.get(id)!;
        s.applicable++;
        if (raw) s.rawPass++;
        if (norm) s.normPass++;
        if (!raw && norm) {
          const rule = (RULES_FOR_CHECK[id] ?? []).find((r) => logged.has(r));
          if (rule) {
            s.fixedBy.set(rule, (s.fixedBy.get(rule) ?? 0) + 1);
            used.add(rule);
          } else rec.unexplained.push({ key: c.key, check: id });
        }
        if (raw && !norm) rec.regressions.push({ key: c.key, check: id });
      }
      for (const r of logged) if (!used.has(r)) rec.noScoreEffect[r] = (rec.noScoreEffect[r] ?? 0) + 1;

      const u = stats.get('unique')!;
      u.applicable++;
      if (review.has(c.key)) continue; // pending a human decision: fails before and after
      const dupRule = dups.get(c.key);
      if (dupRule) {
        u.normPass++;
        u.fixedBy.set(`dedupe:${dupRule}`, (u.fixedBy.get(`dedupe:${dupRule}`) ?? 0) + 1);
      } else {
        u.rawPass++;
        u.normPass++;
      }
    }

    // Dimension score = mean pass rate of its applicable checks; overall = mean of dimensions.
    const dimScore = (which: 'rawPass' | 'normPass') => {
      const out = {} as Record<Dimension, number>;
      for (const d of DIMENSIONS) {
        const rates = CHECKS.filter((ch) => ch.dimension === d)
          .map((ch) => stats.get(ch.id)!)
          .filter((s) => s.applicable > 0)
          .map((s) => (100 * s[which]) / s.applicable);
        out[d] = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 100;
      }
      return out;
    };
    const rawD = dimScore('rawPass');
    const normD = dimScore('normPass');
    const overall = (d: Record<Dimension, number>) => DIMENSIONS.reduce((a, k) => a + d[k], 0) / DIMENSIONS.length;

    // Attribution: a fixed claim on check X adds 100/applicable to X's rate, 1/(checks in dim) of that to the
    // dimension, and 1/5 of that to the overall score.
    const gainedBy: Record<string, number> = {};
    for (const ch of CHECKS) {
      const s = stats.get(ch.id)!;
      const nChecks = CHECKS.filter((x) => x.dimension === ch.dimension && stats.get(x.id)!.applicable > 0).length;
      for (const [rule, n] of s.fixedBy) gainedBy[rule] = (gainedBy[rule] ?? 0) + (100 * n) / s.applicable / nChecks / DIMENSIONS.length;
    }

    const rawO = overall(rawD);
    const normO = overall(normD);
    const r1 = (d: Record<Dimension, number>) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, round1(v)])) as Record<Dimension, number>;
    return {
      payer,
      claims: mine.length,
      raw: { overall: round1(rawO), grade: grade(rawO), dimensions: r1(rawD) },
      normalized: { overall: round1(normO), grade: grade(normO), dimensions: r1(normD) },
      gainedBy: Object.fromEntries(Object.entries(gainedBy).map(([k, v]) => [k, round1(v)]).sort((a, b) => (b[1] as number) - (a[1] as number))),
      checks: CHECKS.map((ch) => ({ id: ch.id, dimension: ch.dimension, label: ch.label, ...stats.get(ch.id)! })).map(({ fixedBy: _f, ...rest }) => rest),
      reconciliation: rec,
    };
  });
}
