// Canonical store: one SQLite file per run (node:sqlite, no install).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Claim, Duplicate, Fix, Issue, Member, ReviewCandidate } from './normalize.ts';

const SCHEMA = `
CREATE TABLE member (
  key TEXT PRIMARY KEY, payer TEXT NOT NULL, golden TEXT NOT NULL, link_evidence TEXT, identifiers TEXT NOT NULL
);
CREATE TABLE claim (
  key TEXT PRIMARY KEY, payer TEXT NOT NULL, source_id TEXT NOT NULL, member_key TEXT, golden_member TEXT,
  claim_id TEXT, type TEXT, status TEXT, service_start TEXT, service_end TEXT, billing_npi TEXT, provider_id_raw TEXT,
  diagnoses TEXT NOT NULL, procedures TEXT NOT NULL, billed REAL, paid REAL, carin_profile INTEGER NOT NULL,
  amount_categories_coded INTEGER NOT NULL, security TEXT NOT NULL, raw TEXT NOT NULL
);
CREATE TABLE duplicate (key TEXT PRIMARY KEY REFERENCES claim(key), duplicate_of TEXT NOT NULL REFERENCES claim(key), rule TEXT NOT NULL, evidence TEXT NOT NULL);
CREATE TABLE review (key TEXT PRIMARY KEY REFERENCES claim(key), candidate_of TEXT NOT NULL REFERENCES claim(key), reasons TEXT NOT NULL, evidence TEXT NOT NULL, decision TEXT);
CREATE TABLE fix (key TEXT NOT NULL, rule TEXT NOT NULL, field TEXT NOT NULL, from_value TEXT NOT NULL, to_value TEXT NOT NULL);
CREATE TABLE issue (key TEXT NOT NULL, rule TEXT NOT NULL, field TEXT NOT NULL, detail TEXT NOT NULL);
CREATE VIEW unique_claim AS SELECT * FROM claim WHERE key NOT IN (SELECT key FROM duplicate);
`;

export interface StoreInput {
  members: Array<Member & { golden: string; evidence: string | null }>;
  claims: Array<Claim & { goldenMember: string | null; raw: unknown }>;
  duplicates: Duplicate[];
  review: ReviewCandidate[];
  fixes: Fix[];
  issues: Issue[];
}

export function writeStore(path: string, s: StoreInput): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.exec('BEGIN');
  const m = db.prepare('INSERT INTO member VALUES (?,?,?,?,?)');
  for (const x of s.members) m.run(x.key, x.payer, x.golden, x.evidence, JSON.stringify(x.identifiers));
  const c = db.prepare('INSERT INTO claim VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const x of s.claims) {
    c.run(x.key, x.payer, x.sourceId, x.memberKey, x.goldenMember, x.claimId, x.type, x.status, x.serviceStart, x.serviceEnd, x.billingNpi, x.providerIdRaw,
      JSON.stringify(x.diagnoses), JSON.stringify(x.procedures), x.billed, x.paid, x.carinProfile ? 1 : 0, x.amountCategoriesCoded ? 1 : 0, JSON.stringify(x.security), JSON.stringify(x.raw));
  }
  const d = db.prepare('INSERT INTO duplicate VALUES (?,?,?,?)');
  for (const x of s.duplicates) d.run(x.key, x.duplicateOf, x.rule, x.evidence);
  const rv = db.prepare('INSERT INTO review VALUES (?,?,?,?,NULL)');
  for (const x of s.review) rv.run(x.key, x.candidateOf, JSON.stringify(x.reasons), x.evidence);
  const f = db.prepare('INSERT INTO fix VALUES (?,?,?,?,?)');
  for (const x of s.fixes) f.run(x.key, x.rule, x.field, x.from, x.to);
  const i = db.prepare('INSERT INTO issue VALUES (?,?,?,?)');
  for (const x of s.issues) i.run(x.key, x.rule, x.field, x.detail);
  db.exec('COMMIT');
  return db;
}
