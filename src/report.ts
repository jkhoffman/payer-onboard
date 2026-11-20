// Render scorecards as Markdown (for the README and PRs) and a standalone HTML page.
import { DIMENSIONS, type PayerScore } from './score.ts';

export interface ReportMeta {
  generatedAt: string;
  sources: Record<string, string>; // payer -> one-line provenance
  duplicates: Record<string, number>;
  review: Record<string, number>;
}

const pct = (n: number) => n.toFixed(1);

export function markdown(scores: PayerScore[], meta: ReportMeta): string {
  const lines: string[] = [];
  lines.push('| Payer | Claims | Raw | After normalization | Change | Top contributors |', '|---|---:|---:|---:|---:|---|');
  for (const s of scores) {
    const top = Object.entries(s.gainedBy).slice(0, 3).map(([r, v]) => `${r} +${v}`).join(', ') || '—';
    lines.push(`| ${s.payer} | ${s.claims} | ${pct(s.raw.overall)} (${s.raw.grade}) | ${pct(s.normalized.overall)} (${s.normalized.grade}) | +${pct(s.normalized.overall - s.raw.overall)} | ${top} |`);
  }
  lines.push('', '| Dimension | ' + scores.map((s) => `${s.payer} raw → norm`).join(' | ') + ' |', '|---|' + scores.map(() => '---:').join('|') + '|');
  for (const d of DIMENSIONS) lines.push(`| ${d} | ` + scores.map((s) => `${pct(s.raw.dimensions[d])} → ${pct(s.normalized.dimensions[d])}`).join(' | ') + ' |');
  lines.push('', `Duplicates marked: ${scores.map((s) => `${s.payer} ${meta.duplicates[s.payer] ?? 0}`).join(', ')}. Pairs waiting for human review: ${scores.map((s) => `${s.payer} ${meta.review[s.payer] ?? 0}`).join(', ')}.`);
  return lines.join('\n');
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const gradeColor = (g: string) => ({ A: '#1a7f37', B: '#2f81f7', C: '#9a6700', D: '#bc4c00', F: '#cf222e' })[g] ?? '#57606a';

export function html(scores: PayerScore[], meta: ReportMeta): string {
  const card = (s: PayerScore) => {
    const bars = DIMENSIONS.map((d) => {
      const r = s.raw.dimensions[d];
      const n = s.normalized.dimensions[d];
      return `<div class="dim"><span class="dl">${d}</span><div class="track"><div class="bar raw" style="width:${r}%"></div><div class="bar norm" style="width:${n}%"></div></div><span class="dv">${pct(r)} → <b>${pct(n)}</b></span></div>`;
    }).join('');
    const gains = Object.entries(s.gainedBy).map(([r, v]) => `<li><code>${esc(r)}</code> +${v}</li>`).join('') || '<li class="muted">No fixable defects found; every gap below is in the source data.</li>';
    const failing = s.checks
      .filter((c) => c.applicable > 0 && c.normPass < c.applicable)
      .sort((a, b) => a.normPass / a.applicable - b.normPass / b.applicable)
      .slice(0, 4)
      .map((c) => `<li>${esc(c.label)}: <b>fails</b> in ${c.applicable - c.normPass} of ${c.applicable}</li>`).join('');
    return `<section class="card">
  <header><h2>${esc(s.payer)}</h2><span class="src">${esc(meta.sources[s.payer] ?? '')}</span></header>
  <div class="grades"><div><span class="g" style="color:${gradeColor(s.raw.grade)}">${s.raw.grade}</span><span class="n">${pct(s.raw.overall)}</span><span class="k">raw</span></div>
  <div class="arrow">→</div><div><span class="g" style="color:${gradeColor(s.normalized.grade)}">${s.normalized.grade}</span><span class="n">${pct(s.normalized.overall)}</span><span class="k">normalized</span></div></div>
  <div class="dims">${bars}</div>
  <div class="cols"><div><h3>Points gained, by rule</h3><ul>${gains}</ul></div><div><h3>Still failing (source data)</h3><ul>${failing || '<li class="muted">nothing</li>'}</ul></div></div>
  <p class="foot">${s.claims} claims · ${meta.duplicates[s.payer] ?? 0} duplicates marked · ${meta.review[s.payer] ?? 0} pairs awaiting human review</p>
</section>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>payer-onboard scorecard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#1f2328;background:#f6f8fa;margin:0;padding:28px}
h1{font-size:20px;margin:0 0 4px}.sub{color:#57606a;margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px}
.card{background:#fff;border:1px solid #d0d7de;border-radius:10px;padding:16px 18px}
.card header{display:flex;flex-direction:column;gap:2px}.card h2{margin:0;font-size:17px}.src{color:#57606a;font-size:12px}
.grades{display:flex;align-items:center;gap:18px;margin:12px 0}.grades>div{display:flex;flex-direction:column;align-items:center}
.g{font-size:34px;font-weight:700;line-height:1}.n{font-weight:600}.k{font-size:11px;color:#57606a;text-transform:uppercase;letter-spacing:.04em}.arrow{font-size:22px;color:#8c959f}
.dim{display:grid;grid-template-columns:92px 1fr 92px;align-items:center;gap:8px;margin:5px 0}.dl{font-size:12px}.dv{font-size:12px;text-align:right;color:#57606a}
.track{position:relative;height:10px;background:#eaeef2;border-radius:5px;overflow:hidden}.bar{position:absolute;top:0;left:0;height:100%;border-radius:5px}
.bar.norm{background:#2da44e;opacity:.85}.bar.raw{background:#8c959f;z-index:1;height:4px;top:3px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px}h3{font-size:12px;margin:0 0 4px;color:#57606a;text-transform:uppercase;letter-spacing:.04em}
ul{margin:0;padding-left:16px;font-size:12px}code{font-size:11px}.muted{color:#8c959f}.foot{color:#57606a;font-size:12px;margin:10px 0 0;border-top:1px solid #eaeef2;padding-top:8px}
.legend{font-size:12px;color:#57606a;margin:-12px 0 16px}.legend i{display:inline-block;width:18px;height:6px;border-radius:3px;margin:0 4px 1px 10px;vertical-align:middle}
</style></head><body>
<h1>Payer onboarding scorecard</h1>
<p class="sub">PIQI-inspired data quality (not a PIQI implementation): Availability, Accuracy, Conformity and Plausibility, plus a Uniqueness extension. Each payer is scored on the data as received and again after normalization; every point gained is attributed to a named fix rule. Synthetic data only. Generated ${esc(meta.generatedAt)}.</p>
<p class="legend">raw<i style="background:#8c959f"></i> normalized<i style="background:#2da44e"></i></p>
<div class="grid">${scores.map(card).join('\n')}</div>
</body></html>`;
}
