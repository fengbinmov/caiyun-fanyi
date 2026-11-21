import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

export interface TranslateOptions {
  token: string;
  endpoint: string;
  transType: string;
  /** 每批携带的文本段数，默认 8。 */
  batchSize?: number;
  /** 每批完成后的进度回调（已翻译段数 / 总段数）。 */
  onProgress?: (done: number, total: number) => void;
  /**
   * 每批完成后的增量回调。partial 与入参等长，尚未翻译的位置是空串，
   * 调用方可以用它立刻渲染出「翻到哪显示到哪」的效果。
   */
  onBatch?: (partial: string[], done: number, total: number) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class TranslationError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, retryable = false, status?: number) {
    super(message);
    this.name = 'TranslationError';
    this.retryable = retryable;
    this.status = status;
  }
}

/** 单条文本超过该长度时先按句子切开，避免超出接口限制。 */
const MAX_CHARS_PER_ITEM = 3000;
/** 单批最多的文本段数上限（实际还会受 batchSize 配置约束）。 */
const MAX_ITEMS_PER_REQUEST = 50;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pickModule(url: URL): typeof http | typeof https {
  return url.protocol === 'http:' ? http : https;
}

function requestJson(
  url: URL,
  payload: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TranslationError('翻译已取消'));
      return;
    }

    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const transport = pickModule(url);

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.byteLength),
          accept: 'application/json',
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', (err) => reject(new TranslationError(`读取响应失败：${err.message}`)));
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new TranslationError('请求超时，请检查网络或代理设置', true));
    });
    req.on('error', (err) => {
      if (err instanceof TranslationError) {
        reject(err);
      } else {
        reject(new TranslationError(`网络请求失败：${err.message}`, true));
      }
    });

    const onAbort = () => req.destroy(new TranslationError('翻译已取消'));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));

    req.write(body);
    req.end();
  });
}

function splitLongText(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }
  // 优先按句末标点/换行切分，其次硬切
  const parts = text.split(/(?<=[。！？；.!?;\n])/);
  const out: string[] = [];
  let current = '';
  for (const part of parts) {
    if ((current + part).length > limit && current) {
      out.push(current);
      current = part;
    } else {
      current += part;
    }
    while (current.length > limit) {
      out.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  if (current) {
    out.push(current);
  }
  return out;
}

async function translateChunk(
  texts: string[],
  opts: TranslateOptions,
  requestId: string,
): Promise<string[]> {
  const url = new URL(opts.endpoint);
  const { status, text } = await requestJson(
    url,
    {
      source: texts,
      trans_type: opts.transType,
      request_id: requestId,
      // 官方文档：trans_type 为 auto2xx 时必须 detect=true，其余方向不需要
      detect: opts.transType.startsWith('auto'),
    },
    { 'x-authorization': `token ${opts.token}` },
    opts.timeoutMs ?? 20_000,
    opts.signal,
  );

  if (status < 200 || status >= 300) {
    const retryable = status === 429 || status >= 500;
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      detail = parsed.message ?? parsed.error ?? detail;
    } catch {
      /* 保持原始文本 */
    }
    if (status === 401 || status === 403) {
      throw new TranslationError('Token 无效或已过期，请重新设置彩云小译 API Token', false, status);
    }
    throw new TranslationError(`接口返回 HTTP ${status}：${detail}`, retryable, status);
  }

  let parsed: { target?: unknown; message?: string };
  try {
    parsed = JSON.parse(text) as { target?: unknown; message?: string };
  } catch {
    throw new TranslationError('接口返回的不是合法 JSON', true, status);
  }

  const target = parsed.target;
  if (!Array.isArray(target)) {
    throw new TranslationError(
      `接口返回格式异常：${parsed.message ?? text.slice(0, 200)}`,
      false,
      status,
    );
  }
  if (target.length !== texts.length) {
    throw new TranslationError(
      `接口返回条数不匹配（请求 ${texts.length} 条，返回 ${target.length} 条）`,
      true,
      status,
    );
  }
  return target.map((item) => (typeof item === 'string' ? item : String(item ?? '')));
}

/**
 * 批量翻译。返回数组与入参一一对应；空字符串原样返回。
 */
export async function translateTexts(
  texts: string[],
  opts: TranslateOptions,
): Promise<string[]> {
  const results = new Array<string>(texts.length).fill('');

  // 空文本不占用接口配额
  const jobs: { index: number; text: string }[] = [];
  texts.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      jobs.push({ index, text: trimmed });
    }
  });
  if (jobs.length === 0) {
    return results;
  }

  const limit = Math.max(1, Math.min(opts.batchSize ?? 8, MAX_ITEMS_PER_REQUEST));
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let done = 0;
  opts.onProgress?.(0, jobs.length);

  for (let i = 0; i < jobs.length; i += limit) {
    if (opts.signal?.aborted) {
      throw new TranslationError('翻译已取消');
    }
    const batch = jobs.slice(i, i + limit);

    // 超长文本拆开翻译后再拼回去
    const expanded: { index: number; pieces: string[] }[] = batch.map((job) => ({
      index: job.index,
      pieces: splitLongText(job.text, MAX_CHARS_PER_ITEM),
    }));
    const flat = expanded.flatMap((item) => item.pieces);

    let attempt = 0;
    for (;;) {
      try {
        const translated = await translateChunk(flat, opts, requestId);
        let cursor = 0;
        for (const item of expanded) {
          const slice = translated.slice(cursor, cursor + item.pieces.length);
          cursor += item.pieces.length;
          results[item.index] = slice.join(' ');
        }
        break;
      } catch (err) {
        attempt += 1;
        const retryable = err instanceof TranslationError ? err.retryable : true;
        if (!retryable || attempt > 2 || opts.signal?.aborted) {
          throw err instanceof Error ? err : new TranslationError(String(err));
        }
        await sleep(600 * 2 ** (attempt - 1));
        if (opts.signal?.aborted) {
          throw new TranslationError('翻译已取消');
        }
      }
    }

    done += batch.length;
    opts.onBatch?.([...results], done, jobs.length);
    opts.onProgress?.(done, jobs.length);
  }

  return results;
}
