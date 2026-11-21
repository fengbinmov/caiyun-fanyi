// 占位符存活率矩阵：4 种形式 × 6 种上下文
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const token = process.env.CAIYUN_TOKEN;
if (!token) {
  console.error('缺少 CAIYUN_TOKEN');
  process.exit(1);
}

const outdir = mkdtempSync(join(tmpdir(), 'caiyun-probe2-'));
const outfile = join(outdir, 'translator.mjs');
await build({
  entryPoints: ['src/translator.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'error',
});
const { translateTexts } = await import(pathToFileURL(outfile).href);

const ENDPOINT = 'https://api.interpreter.caiyunai.com/v1/translator';

const forms = [
  { name: '{{0}}', make: (i) => `{{${i}}}` },
  { name: '[[0]]', make: (i) => `[[${i}]]` },
  { name: '((0))', make: (i) => `((${i}))` },
  { name: 'XQ0QX', make: (i) => `XQ${i}QX` },
];

const contexts = [
  (m) => `安装插件后按 ${m} 打开预览`,
  (m) => `点击 [设置](${m}) 打开配置`,
  (m) => `这段代码 ${m} 很好用`,
  (m) => `${m} 是开头部分`,
  (m) => `这是结尾部分 ${m}`,
  (m) => `中英 mixed ${m} text 混排`,
];

// 每个 form 用自己的编号段，避免互相混淆
const sources = [];
const records = [];
forms.forEach((form, formIndex) => {
  contexts.forEach((ctx, ctxIndex) => {
    const mark = form.make(formIndex * 10 + ctxIndex);
    sources.push(ctx(mark));
    records.push({ form: form.name, order: `${formIndex}-${ctxIndex}`, ctxIndex, mark });
  });
});

const result = await translateTexts(sources, {
  token,
  endpoint: ENDPOINT,
  transType: 'zh2en',
  batchSize: 24,
});

const scoreboard = new Map();
records.forEach((record, index) => {
  const out = String(result[index] ?? '');
  const ok = out.includes(record.mark);
  const entry = scoreboard.get(record.form) ?? { pass: 0, total: 0, fails: [] };
  entry.total += 1;
  if (ok) {
    entry.pass += 1;
  } else {
    entry.fails.push(`${record.ctxIndex}: ${out}`);
  }
  scoreboard.set(record.form, entry);
});

console.log('\n=== 存活率 ===');
for (const [form, entry] of scoreboard) {
  console.log(`${form.padEnd(8)} ${entry.pass}/${entry.total}`);
  entry.fails.forEach((f) => console.log(`   失败 — ${f}`));
}

const best = [...scoreboard.entries()].sort((a, b) => b[1].pass - a[1].pass)[0];
console.log(`\n最佳形式：${best[0]} (${best[1].pass}/${best[1].total})`);
