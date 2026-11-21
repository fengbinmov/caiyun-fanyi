// 用本地假服务器验证 src/translator.ts：请求体、鉴权头、分批、进度、重试、错误处理
import { build } from 'esbuild';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const outdir = mkdtempSync(join(tmpdir(), 'caiyun-test-'));
const outfile = join(outdir, 'translator.mjs');
await build({
  entryPoints: ['src/translator.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'error',
});
const { translateTexts, TranslationError } = await import(pathToFileURL(outfile).href);

const requests = [];
let flakyHits = 0;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const payload = JSON.parse(body);
    const url = req.url ?? '';
    requests.push({ url, headers: req.headers, payload });

    if (url.includes('fail401')) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'invalid token' }));
      return;
    }
    if (url.includes('flaky')) {
      flakyHits += 1;
      if (flakyHits === 1) {
        res.statusCode = 503;
        res.end('busy');
        return;
      }
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ target: payload.source.map((s) => `EN[${s}]`) }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const check = (ok, label, extra = '') => {
  if (!ok) failures.push(label);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
};

// ---- 1. 正常分批 + 进度 + 请求格式
requests.length = 0;
const progress = [];
const texts = ['一', '', '二', '  ', '三', '四', '五'];
const result = await translateTexts(texts, {
  token: 'tok-123',
  endpoint: `${base}/v1/translator`,
  transType: 'zh2en',
  batchSize: 3,
  onProgress: (done, total) => progress.push([done, total]),
});

check(requests.length === 2, '7 条(去空 5 条)按 batchSize=3 分成 2 次请求', `实际 ${requests.length} 次`);
check(requests[0].payload.source.length === 3, '首批 3 条');
check(requests[1].payload.source.length === 2, '次批 2 条');
check(requests[0].headers['x-authorization'] === 'token tok-123', 'x-authorization 头正确', requests[0].headers['x-authorization']);
check(requests[0].payload.trans_type === 'zh2en', 'trans_type 透传');
check(requests[0].payload.detect === false, 'zh2en 时 detect=false（非 auto 方向）');
check(typeof requests[0].payload.request_id === 'string' && requests[0].payload.request_id.length > 0, 'request_id 非空');
check(requests[0].headers['content-type'] === 'application/json', 'content-type 正确');
check(JSON.stringify(progress) === '[[0,5],[3,5],[5,5]]', '进度回调序列', JSON.stringify(progress));
check(result.length === texts.length, '返回数组长度与入参一致');
check(result[1] === '' && result[3] === '', '空文本原样返回空串');
check(result[0] === 'EN[一]' && result[6] === 'EN[五]', '译文按原索引回填', JSON.stringify(result));

// ---- 2. auto 方向必须带 detect=true
requests.length = 0;
await translateTexts(['甲'], { token: 't', endpoint: `${base}/v1/translator`, transType: 'auto2zh' });
check(requests[0].payload.detect === true, 'auto2zh 时 detect=true（官方要求）');

// ---- 2b. 增量回调：每批完成就吐出当前进度
requests.length = 0;
const batches = [];
await translateTexts(['一', '二', '三', '四', '五', '六', '七'], {
  token: 't',
  endpoint: `${base}/v1/translator`,
  transType: 'zh2en',
  batchSize: 3,
  onBatch: (partial, done, total) =>
    batches.push({ len: partial.length, done, total, filled: partial.filter(Boolean).length }),
});
check(batches.length === 3, 'onBatch 每批回调一次', `${batches.length} 次`);
check(batches.every((b) => b.len === 7), 'partial 数组长度与入参一致');
check(batches.every((b) => b.total === 7), 'total 是待翻译段数');
check(
  JSON.stringify(batches.map((b) => b.filled)) === '[3,6,7]',
  'partial 逐步填充，未翻译位置为空串',
  JSON.stringify(batches.map((b) => b.filled)),
);
check(
  JSON.stringify(batches.map((b) => b.done)) === '[3,6,7]',
  'done 随批次递增',
  JSON.stringify(batches.map((b) => b.done)),
);

// ---- 3. 超长文本自动切分
requests.length = 0;
const long = '中'.repeat(3500);
const longResult = await translateTexts([long], {
  token: 't',
  endpoint: `${base}/v1/translator`,
  transType: 'zh2en',
  batchSize: 5,
});
check(requests[0].payload.source.length === 2, '超长文本被切成 2 段发送', String(requests[0].payload.source.length));
check(longResult[0].startsWith('EN[') && longResult[0].includes('] EN['), '切分后被拼回');

// ---- 3. 401 不重试
requests.length = 0;
let err401 = null;
try {
  await translateTexts(['甲'], { token: 'bad', endpoint: `${base}/fail401`, transType: 'zh2en' });
} catch (error) {
  err401 = error;
}
check(err401 instanceof TranslationError, '401 抛出 TranslationError');
check(requests.length === 1, '401 不重试', `请求 ${requests.length} 次`);
check(err401 && /Token 无效/.test(err401.message), '401 给出可读提示', err401?.message);

// ---- 4. 5xx 自动重试
requests.length = 0;
flakyHits = 0;
const flakyResult = await translateTexts(['乙'], {
  token: 't',
  endpoint: `${base}/flaky`,
  transType: 'zh2en',
});
check(requests.length === 2, '503 后重试一次并成功', `请求 ${requests.length} 次`);
check(flakyResult[0] === 'EN[乙]', '重试后拿到结果');

// ---- 5. 取消
const controller = new AbortController();
controller.abort();
let cancelled = null;
try {
  await translateTexts(['丙'], {
    token: 't',
    endpoint: `${base}/v1/translator`,
    transType: 'zh2en',
    signal: controller.signal,
  });
} catch (error) {
  cancelled = error;
}
check(cancelled instanceof TranslationError && /取消/.test(cancelled.message), '已取消的信号会中止', cancelled?.message);

server.close();
console.log('');
if (failures.length > 0) {
  console.error(`共 ${failures.length} 项失败：${failures.join('; ')}`);
  process.exit(1);
}
console.log('全部检查通过 ✅');
