// 真实接口验证：英文 → 中文（需要 CAIYUN_TOKEN 环境变量，不会写入任何文件）
import { build } from 'esbuild';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const token = process.env.CAIYUN_TOKEN;
if (!token) {
  console.error('缺少 CAIYUN_TOKEN 环境变量');
  process.exit(1);
}

const ENDPOINT = 'https://api.interpreter.caiyunai.com/v1/translator';
const outdir = mkdtempSync(join(tmpdir(), 'caiyun-live-'));

async function buildModule(entry, name) {
  const outfile = join(outdir, `${name}.mjs`);
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'error',
  });
  return import(pathToFileURL(outfile).href);
}

const translator = await buildModule('src/translator.ts', 'translator');
const md = await buildModule('src/markdownTranslator.ts', 'markdownTranslator');

const failures = [];
const check = (ok, label, extra = '') => {
  if (!ok) failures.push(label);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
};

const CJK = /[\u4e00-\u9fff]/;
const base = { token, endpoint: ENDPOINT, transType: 'en2zh', batchSize: 8 };
const DIRECTION = 'to-zh';

// ---------------------------------------------------------------- 1. 基本连通
console.log('\n=== 1. 基本连通性（英文 → 中文）===');
const r1 = await translator.translateTexts(
  ['The weather is nice today, let us go out for a walk.'],
  base,
);
console.log('原文：The weather is nice today, let us go out for a walk.');
console.log('译文：', r1[0]);
check(Boolean(r1[0] && r1[0].trim()), '返回非空译文');
check(CJK.test(r1[0]), '译文是中文', r1[0]);
check(/天气|散步|走/.test(r1[0]), '译文语义正确', r1[0]);

// ---------------------------------------------------------------- 2. 行内保护
console.log('\n=== 2. 行内保护（代码 / 链接 / 强调标记）===');
const inlineSrc =
  'This is a **sample** paragraph with code `const a = 1` and a [link](https://example.com/a).';
const inlinePlan = md.planSegments(inlineSrc, DIRECTION);
const maskedText = inlinePlan.segments[0].masked;
console.log('遮罩后：', maskedText);

const r2 = await translator.translateTexts(inlinePlan.texts, base);
console.log('引擎返回：', r2[0]);

const rebuilt = md.buildTranslatedMarkdown(inlineSrc, r2, DIRECTION);
console.log('最终行：', rebuilt.content);

check(rebuilt.applied === 1, '行内保护译文可安全回填', `${rebuilt.applied}/1`);
check(rebuilt.content.includes('**') && !rebuilt.content.includes('* *'), '强调标记还原完整', rebuilt.content);
check(rebuilt.content.includes('`const a = 1`'), '行内代码原样还原', rebuilt.content);
check(rebuilt.content.includes('https://example.com/a'), '链接 URL 原样还原', rebuilt.content);
check(CJK.test(rebuilt.content), '正文已译为中文', rebuilt.content);

// ---------------------------------------------------------------- 3. 批量一致性
console.log('\n=== 3. 批量请求顺序一致性 ===');
const batch = ['First paragraph.', 'Second paragraph.', 'Third paragraph.'];
const r3 = await translator.translateTexts(batch, base);
console.log(r3);
check(r3.length === 3, '返回条数与请求一致');
check(r3.every((t) => t && CJK.test(t)), '三条都已译为中文');

// ---------------------------------------------------------------- 4. 端到端
console.log('\n=== 4. 端到端：examples/demo.md ===');
const source = readFileSync(new URL('../examples/demo.md', import.meta.url), 'utf8');
const srcLines = source.split('\n');
const plan = md.planSegments(source, DIRECTION);
console.log(`切出 ${plan.segments.length} 个待翻译段落`);

const translations = await translator.translateTexts(
  plan.texts,
  { ...base, onProgress: (done, total) => process.stdout.write(`  进度 ${done}/${total}\r`) },
);
process.stdout.write('\n');

const built = md.buildTranslatedMarkdown(source, translations, DIRECTION);
console.log(`回填 ${built.applied}/${built.total}`);
check(built.applied === built.total, '全部段落成功回填', `${built.applied}/${built.total}`);

const outLines = built.content.split('\n');
check(outLines.length === srcLines.length, '行数一致');

// 代码块必须逐字不变
const fenceStart = srcLines.findIndex((l) => l.trim().startsWith('```'));
const fenceEnd = srcLines.findIndex((l, i) => i > fenceStart && l.trim().startsWith('```'));
const codeSame = srcLines
  .slice(fenceStart, fenceEnd + 1)
  .every((line, i) => outLines[fenceStart + i] === line);
check(codeSame, '代码块逐字未变');

// 原本就是中文的段落不该被改动
const chineseIdx = srcLines.findIndex((l) => l.startsWith('这个段落故意用中文写'));
check(chineseIdx > 0 && outLines[chineseIdx] === srcLines[chineseIdx], '原有中文段落保持原样');

// 未回填的段落，看看卡在哪
if (built.rejected.length > 0) {
  for (const index of built.rejected) {
    const segment = plan.segments[index];
    console.log('  被拒句：', JSON.stringify(segment.masked));
    console.log('  引擎返回：', JSON.stringify(translations[segment.textIndex ?? 0]));
  }
}

// 抽样展示
console.log('\n--- 译文抽样 ---');
plan.segments.slice(0, 6).forEach((segment) => {
  console.log(`原: ${srcLines[segment.line]}`);
  console.log(`译: ${outLines[segment.line]}`);
  console.log('');
});

// ---------------------------------------------------------------- 5. auto2zh
console.log('=== 5. auto2zh 可用性 ===');
try {
  const auto = await translator.translateTexts(['This is a test.'], {
    ...base,
    transType: 'auto2zh',
  });
  console.log('auto2zh 返回：', auto[0]);
  check(CJK.test(auto[0]), 'auto2zh 返回中文', auto[0]);
} catch (error) {
  console.log('auto2zh 失败：', error.message);
  failures.push(`auto2zh 不可用：${error.message}`);
}

console.log('');
if (failures.length > 0) {
  console.error(`共 ${failures.length} 项失败：${failures.join('; ')}`);
  process.exit(1);
}
console.log('全部真实调用检查通过 ✅');
