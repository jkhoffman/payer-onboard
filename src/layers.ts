import type { PayerLayer, SpecLayer, VendorLayer } from './types.ts';

export type LayerName = 'spec' | 'vendor' | 'payer' | 'override';

export interface Effective {
  baseUrl: string;
  rateLimit: { requestsPerSecond: number; burst: number };
  retry: { maxAttempts: number; baseDelayMs: number };
  paging: { style: 'next-link'; pageSize: number };
  searchDefaults: Record<string, Record<string, string>>;
  probe: { maxClaims: number; maxPatients: number; searchCheckCount: number };
  /** Set only by an override: recorded files to use when there is no live access (e.g. no OAuth token yet). */
  normalize: { codeSystemAliases: Record<string, string>; amountAliases: { billed?: string[]; paid?: string[] } };
  searchVariants?: Record<string, Record<string, string>>;
  sync?: { strategy: 'full' | 'incremental' };
  clientSideFilter?: string[];
  dataSource?: { kind: 'bundle-files'; paths: string[]; note?: string };
  /** Which layer set each leaf, keyed by display path. This is what `explain` prints. */
  provenance: Record<string, LayerName>;
  /** The same leaves as key segments, because keys can contain dots (code-system URLs). */
  provenancePaths: Record<string, string[]>;
}

type Tree = { [k: string]: unknown };

function isTree(v: unknown): v is Tree {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Dotted display path; a key that itself contains a dot is shown in brackets. */
const display = (segs: string[]) => segs.map((s, i) => (s.includes('.') ? `[${s}]` : i ? `.${s}` : s)).join('');

function overlay(target: Tree, source: Tree, layer: LayerName, prov: Record<string, LayerName>, paths: Record<string, string[]>, path: string[] = []): void {
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    const p = [...path, k];
    if (isTree(v)) {
      const next = isTree(target[k]) ? (target[k] as Tree) : {};
      target[k] = next;
      overlay(next, v, layer, prov, paths, p);
    } else {
      target[k] = v;
      prov[display(p)] = layer;
      paths[display(p)] = p;
    }
  }
}

/** spec → vendor → payer → payer.overrides. Later layers win, leaf by leaf. */
export function resolve(spec: SpecLayer, vendor: VendorLayer | null, payer: PayerLayer): Effective {
  const prov: Record<string, LayerName> = {};
  const paths: Record<string, string[]> = {};
  const tree: Tree = {};
  overlay(tree, { ...spec.defaults, searchDefaults: {}, normalize: { codeSystemAliases: {}, amountAliases: {} } }, 'spec', prov, paths);
  if (vendor) {
    overlay(
      tree,
      { paging: vendor.paging, rateLimit: vendor.rateLimit, searchDefaults: vendor.searchDefaults, normalize: vendor.normalize } as Tree,
      'vendor',
      prov,
      paths,
    );
  }
  overlay(tree, { baseUrl: payer.payer.baseUrl }, 'payer', prov, paths);
  if (payer.overrides) overlay(tree, payer.overrides as Tree, 'override', prov, paths);
  return { ...(tree as unknown as Omit<Effective, 'provenance' | 'provenancePaths'>), provenance: prov, provenancePaths: paths };
}
