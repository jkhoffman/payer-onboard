import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import type { PayerLayer, SpecLayer, VendorLayer } from './types.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function readYaml<T>(path: string): T {
  return parse(readFileSync(path, 'utf8')) as T;
}

export function writeYaml(path: string, value: unknown, header?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = stringify(value, { lineWidth: 0 });
  writeFileSync(path, header ? `${header}\n${body}` : body);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function loadSpec(id = 'carin-bb-2.2.0'): SpecLayer {
  return readYaml<SpecLayer>(join(ROOT, 'specs', `${id}.yaml`));
}

export function loadVendors(): VendorLayer[] {
  const dir = join(ROOT, 'vendors');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => readYaml<VendorLayer>(join(dir, f)));
}

export function payerPath(id: string): string {
  return join(ROOT, 'payers', `${id}.yaml`);
}

export function loadPayer(id: string): PayerLayer {
  const path = payerPath(id);
  if (!existsSync(path)) throw new Error(`No payer config at ${path}; run discover first`);
  return readYaml<PayerLayer>(path);
}
