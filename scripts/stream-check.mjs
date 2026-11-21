// 验证流式渲染：每批翻译完成后，预览内容是否逐步变成译文
import { build } from 'esbuild';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const outdir = mkdtempSync(join(tmpdir(), 'caiyun-stream-'));

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

const { translateTexts } = await buildModule('src/translator.ts', 'translator');
const md = await buildModule('src/markdownTranslator.ts', 'markdownTranslator');

const failures = [];
const check = (ok, label, extra = '') => {
  if (!ok) failures.push(label);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
};

// 假服务器：把英文原文前面加「译:」，模拟英文→中文
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const payload = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ target: payload.source.map((s) => `译:${s}`) }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1/translator`;

const source = readFileSync(new URL('../examples/demo.md', import.meta.url), 'utf8');
const plan = md.planSegments(source, 'to-zh');

const snapshots = [];
const translations = await translateTexts(plan.texts, {
  token: 't',
  endpoint,
  transType: 'en2zh',
  batchSize: 5,
  onBatch: (partial, done, total) => {
    const { content, applied } = md.buildTranslatedMarkdown(source, partial, 'to-zh');
    snapshots.push({
      done,
      total,
      applied,
      // 已翻好的行数用「译:」的条数衡量，这是真正渲染出去的可见结果
      visible: (content.match(/译:/g) ?? []).length,
      lines: content.split('\n').length,
    });
  },
});

const srcLines = source.split('\n').length;
console.log('\n渲染快照：');
snapshots.forEach((s) => console.log(`  第 ${s.done}/${s.total} 段 → 已回填 ${s.applied} 行，可见译文 ${s.visible} 处`));

check(snapshots.length >= 2, '多批次触发多次渲染', `${snapshots.length} 次`);
check(snapshots[0].visible > 0, '第一批完成后预览就已出现译文（不用等全文）', String(snapshots[0].visible));
check(
  snapshots[0].visible < snapshots[snapshots.length - 1].visible,
  '译文内容逐批增加',
  `${snapshots[0].visible} → ${snapshots[snapshots.length - 1].visible}`,
);
check(
  snapshots.every((s, i) => i === 0 || s.visible >= snapshots[i - 1].visible),
  '可见译文数量单调不减',
);
check(snapshots.every((s) => s.lines === srcLines), '每次快照的行数都与原文一致（滚动位置不跳）');

const finalBuilt = md.buildTranslatedMarkdown(source, translations, 'to-zh');
check(finalBuilt.applied === finalBuilt.total, '最终全部回填', `${finalBuilt.applied}/${finalBuilt.total}`);

// ---- 双语对照依赖「原文块与译文块一一对应」
const sourceBlocks = md.splitBlocks(source);
const translatedBlocks = md.splitBlocks(finalBuilt.content);
check(
  sourceBlocks.length === translatedBlocks.length,
  '切块后原文与译文块数一致（双语对照不会错位）',
  `${sourceBlocks.length} vs ${translatedBlocks.length}`,
);
check(
  sourceBlocks.every((block) => !block.includes('\n\n')),
  '块内部不含空行',
);
check(
  translatedBlocks.some((block) => /[\u4e00-\u9fff]/.test(block)),
  '译文块确实含中文',
);

// ---- 双语视图的双份判据：翻译前后不一样就双份（段落/标题/表格都算）
const paired = sourceBlocks.filter(
  (block, index) => translatedBlocks[index] !== undefined && translatedBlocks[index] !== block,
);
check(paired.length > 0, '存在需要双份对照的块', `${paired.length} 块`);
check(
  paired.some((block) => md.classifyBlock(block) === 'heading'),
  '标题参与双份对照',
);
check(
  paired.some((block) => md.classifyBlock(block) === 'table'),
  '表格参与双份对照',
);
check(
  !paired.some((block) => md.classifyBlock(block) === 'code'),
  '代码块不参与双份（不会重复显示）',
);

server.close();

console.log('');
if (failures.length > 0) {
  console.error(`共 ${failures.length} 项失败：${failures.join('; ')}`);
  process.exit(1);
}
console.log('流式渲染检查通过 ✅');
