// 验证 src/markdownTranslator.ts：结构保护、遮罩还原、安全校验
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const outdir = mkdtempSync(join(tmpdir(), 'caiyun-md-'));
const outfile = join(outdir, 'markdownTranslator.mjs');
await build({
  entryPoints: ['src/markdownTranslator.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'error',
});
const { planSegments, buildTranslatedMarkdown } = await import(pathToFileURL(outfile).href);

const failures = [];
const check = (ok, label, extra = '') => {
  if (!ok) failures.push(label);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
};

const doc = [
  '# 项目介绍',
  '',
  '这是一个**示例**段落，包含代码 `const a = 1` 和[链接](https://example.com/a)。',
  '',
  '## 二级标题',
  '',
  '- 第一项',
  '- 第二项',
  '',
  '> 引用文字',
  '',
  '| 名称 | 说明 |',
  '|---|---|',
  '| 表格 | 中文内容 |',
  '',
  '---',
  '',
  '```js',
  '// 注释里有中文',
  "const s = '你好';",
  '```',
  '',
  '结尾段落。',
].join('\n');

const plan = planSegments(doc);
const masks = plan.segments.map((s) => s.masked);

console.log('    切出的段落:', JSON.stringify(masks, null, 0));

check(plan.segments.length > 0, '能切出待翻译段落');
check(
  !masks.some((m) => m.includes('注释里有中文') || m.includes('你好')),
  '围栏代码块内中文未被切出',
);
check(
  masks.every((m) => !m.includes('https://example.com/a')),
  '链接 URL 被遮罩',
);
check(
  masks.every((m) => !m.includes('`const a = 1`')),
  '行内代码被遮罩',
);
check(
  !plan.segments.some((s) => s.line === 15),
  '水平线行未被切出',
);

const heading = plan.segments.find((s) => s.line === 0);
check(heading?.prefix === '# ', '标题前缀被正确剥离', JSON.stringify(heading?.prefix));
const listItem = plan.segments.find((s) => s.line === 6);
check(listItem?.prefix === '- ', '列表前缀被正确剥离', JSON.stringify(listItem?.prefix));
const quote = plan.segments.find((s) => s.line === 9);
check(quote?.prefix === '> ', '引用前缀被正确剥离', JSON.stringify(quote?.prefix));

// ---- 假译文：把待翻译文本里的中文整体换成 EN，保留占位符与结构标记
const translations = plan.texts.map((t) => t.replace(/[\u4e00-\u9fff]+/g, 'EN'));
const built = buildTranslatedMarkdown(doc, translations);
const outLines = built.content.split('\n');

check(
  plan.texts.length === plan.segments.length + 1,
  '链接文字被单列为翻译任务',
  `texts=${plan.texts.length} segments=${plan.segments.length}`,
);
check(built.applied === plan.segments.length, '全部段落回填成功', `${built.applied}/${plan.segments.length}`);
check(outLines.length === doc.split('\n').length, '行数保持不变');
check(outLines[0] === '# EN', '标题前缀保留且正文被替换', outLines[0]);
check(outLines[6] === '- EN', '列表前缀保留', outLines[6]);
check(outLines[9] === '> EN', '引用前缀保留', outLines[9]);
check(outLines[18] === '// 注释里有中文', '代码块内容原样保留', outLines[18]);
check(outLines[19] === "const s = '你好';", '代码块字符串原样保留', outLines[19]);
check(outLines[15] === '---', '水平线原样保留');
check(
  outLines[2].includes('`const a = 1`') && outLines[2].includes('https://example.com/a'),
  '行内代码与链接 URL 原文还原',
  outLines[2],
);
check(outLines[2].startsWith('EN'), '正文行从行首正常开始', outLines[2]);

// ---- 不安全的译文必须被拦下
const cjkResult = buildTranslatedMarkdown(doc, plan.segments.map(() => '这段译文还是中文'));
check(cjkResult.applied === 0, '含中文的译文被拒绝', `applied=${cjkResult.applied}`);
check(cjkResult.content === doc, '被拒绝时文档完全保持原样');

const droppedMask = buildTranslatedMarkdown('看看 `code` 这里', ['EN without mask']);
check(droppedMask.applied === 0, '占位符丢失的译文被拒绝', `applied=${droppedMask.applied}`);

const droppedMarkers = buildTranslatedMarkdown('这是**重点**内容', ['This is key content']);
check(droppedMarkers.applied === 0, '强调标记被吃掉的译文被拒绝', `applied=${droppedMarkers.applied}`);

const goodEn = buildTranslatedMarkdown('这是**重点**内容', ['This is XQ0QXkeyXQ1QX content']);
check(goodEn.applied === 1 && goodEn.content === 'This is **key** content', '合规译文正常回填', goodEn.content);

// ---- 空文档 / 无中文文档
const none = planSegments('# Title\n\nEnglish only.');
check(none.segments.length === 0, '无中文文档切不出段落');
const emptyBuilt = buildTranslatedMarkdown('# Title\n\nEnglish only.', []);
check(emptyBuilt.applied === 0 && emptyBuilt.total === 0, '无中文文档原样返回');

// ---- 英文 → 中文方向
console.log('\n--- 方向：to-zh（英文译中文）---');
const enDoc = [
  '# Project Title',
  '',
  'This is a **sample** paragraph with code `const a = 1` and a [link](https://example.com/a).',
  '',
  '```js',
  '// keep me',
  '```',
  '',
  '这个段落是中文，不应该被翻译。',
].join('\n');

const enPlan = planSegments(enDoc, 'to-zh');
console.log('  切出：', JSON.stringify(enPlan.texts));

check(enPlan.segments.length > 0, 'to-zh 能切出英文段落');
check(
  enPlan.texts.some((t) => t.includes('XQ')) && enPlan.texts.some((t) => t.startsWith('This')),
  '正文与链接文字都进入任务队列',
);
check(
  !enPlan.texts.some((t) => t.includes('这个段落是中文')),
  '原中文段落未被选中',
);
check(
  !enPlan.segments.some((s) => s.line === 5),
  '代码块未被选中',
);

// 把所有非占位符的英文词换成「中」，模拟英文→中文的译文（先保护占位符，否则会被 [A-Za-z]+ 吞掉）
const fakeToChinese = (masked) => {
  const saved = [];
  const protectedText = masked.replace(/XQ\d+QX/g, (piece) => {
    saved.push(piece);
    return `\u0000${saved.length - 1}\u0000`;
  });
  return protectedText
    .replace(/[A-Za-z]+/g, '中')
    .replace(/\u0000(\d+)\u0000/g, (_m, i) => saved[Number(i)] ?? '');
};
const enTranslations = enPlan.texts.map(fakeToChinese);
const enBuilt = buildTranslatedMarkdown(enDoc, enTranslations, 'to-zh');
const enOut = enBuilt.content.split('\n');

check(enBuilt.applied === enBuilt.total, 'to-zh 全部回填', `${enBuilt.applied}/${enBuilt.total}`);
check(enOut[0] === '# 中 中', '标题被译为中文', enOut[0]);
check(enOut[5] === '// keep me', '代码块保持原样', enOut[5]);
check(enOut[8] === '这个段落是中文，不应该被翻译。', '原中文段落保持不变', enOut[8]);
check(
  enOut[2].includes('**') && !enOut[2].includes('* *'),
  'to-zh 强调标记完好',
  enOut[2],
);
check(
  enOut[2].includes('`const a = 1`') && enOut[2].includes('https://example.com/a'),
  'to-zh 代码与链接完好',
  enOut[2],
);

// 反向保护：英文文档用 from-zh 方向时，不该被当成正文
const wrongDirection = planSegments(enDoc, 'from-zh');
check(
  wrongDirection.texts.every((t) => !t.startsWith('This')),
  '方向选错时英文正文不会被选中',
);

console.log('');
if (failures.length > 0) {
  console.error(`共 ${failures.length} 项失败：${failures.join('; ')}`);
  process.exit(1);
}
console.log('全部检查通过 ✅');
