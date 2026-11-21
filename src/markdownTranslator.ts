/**
 * Markdown 源码的「保护式」翻译。
 *
 * 思路：只把真正需要翻译的自然语言切出来送翻译，其余（代码、URL、HTML 标签、强调标记、乃至整个链接语法）
 * 全部替换成占位符，翻译结果写回后再还原。这样翻译引擎完全看不到 Markdown 语法，也就无从破坏它。
 *
 * 占位符形式是 XQnQX，这是实测算出来的：彩云引擎会把 ⟦⟧、§§、【】、~~ 改写或吃掉，把 ** 拆成 "* *"，
 * 连 {{n}} 在紧贴中文时都会丢一个花括号；而「伪英文单词」形式在 6 种上下文里 6/6 原样保留。
 *
 * 链接 `[文字](url)` 整体遮罩，文字作为独立任务单独翻译，避免引擎把 `](...)` 当 URL 处理而丢掉。
 */

const MASK_RE = /XQ(\d+)QX/g;
const CJK_RE = /[\u4e00-\u9fff]/;
const LATIN_RE = /[A-Za-z]/;

/** 翻译方向：从中文译出 / 译入中文 / 自动检测。决定「什么样的行才算正文」。 */
export type Direction = 'from-zh' | 'to-zh' | 'auto';

export function resolveDirection(transType: string): Direction {
  if (transType.startsWith('auto')) {
    return 'auto';
  }
  return transType.startsWith('zh') ? 'from-zh' : 'to-zh';
}

/** 行内结构：缩进、引用符号、列表符号、标题符号。 */
const PREFIX_RE = /^(\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?(?:#{1,6}\s+)?)/;

/** 表格分隔行、水平线、链接定义行、HTML 注释行，都不参与翻译。 */
const TABLE_DIVIDER_RE = /^\s*\|?[\s:|-]+\|?\s*$/;
const HR_RE = /^\s*([-*_])\s*(?:\1\s*){2,}$/;
const LINK_DEF_RE = /^\s*\[[^\]]+\]:\s*\S+/;
const COMMENT_RE = /^\s*<!--/;

export interface MaskValue {
  /** 被遮罩的原始片段。 */
  raw: string;
  /** 强调标记的角色：开 / 闭。用于还原时把标记贴紧内侧文字。 */
  role?: 'open' | 'close';
  /** 若这是链接，链接目标。 */
  url?: string;
  /** 若这是链接，链接文字。 */
  label?: string;
  /** 链接文字在 SegmentPlan.texts 中的下标。 */
  labelIndex?: number;
}

export interface MarkdownSegment {
  /** 在原文中的行号（0 起）。 */
  line: number;
  /** 行首结构前缀，拼回时原样保留。 */
  prefix: string;
  /** 遮罩后的文本，送翻译的就是它。 */
  masked: string;
  /** 被遮罩片段，按索引还原。 */
  values: MaskValue[];
  /** 在 SegmentPlan.texts 中的下标；纯链接行没有正文，故为 undefined。 */
  textIndex?: number;
}

export interface SegmentPlan {
  lines: string[];
  segments: MarkdownSegment[];
  /** 按固定顺序排列的全部待翻译文本：先各段 masked，再各链接文字。 */
  texts: string[];
}

export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 这段文字里有没有「源语言」的正文。旁白：不能拿去掉占位符之前的串判断，XQnQX 本身就是字母。 */
function hasSourceText(text: string, direction: Direction): boolean {
  switch (direction) {
    case 'from-zh':
      return CJK_RE.test(text);
    case 'to-zh':
      return LATIN_RE.test(text);
    default:
      return CJK_RE.test(text) || LATIN_RE.test(text);
  }
}

function maskInline(input: string): { masked: string; values: MaskValue[] } {
  const values: MaskValue[] = [];
  let out = input;

  const protect = (pattern: RegExp, build?: (match: string) => MaskValue) => {
    out = out.replace(pattern, (match) => {
      values.push(build ? build(match) : { raw: match });
      return `XQ${values.length - 1}QX`;
    });
  };

  protect(/`[^`\n]*`/g); // 行内代码
  protect(/!\[[^\]]*\]\([^)]*\)/g); // 图片（alt 不翻译）
  protect(/<https?:\/\/[^>\s]*>/g); // 自动链接
  protect(/<[a-zA-Z/!][^>\n]*>/g); // HTML 标签
  protect(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (match) => {
    const parts = /^\[([^\]\n]*)\]\(([^)\s]+)\)$/.exec(match);
    return parts ? { raw: match, label: parts[1], url: parts[2] } : { raw: match };
  }); // 行内链接，整体遮罩

  // 强调标记：按出现顺序配对，奇数位为开标记、偶数位为闭标记
  const emphasisDepth = new Map<string, number>();
  protect(/~~|__|\*\*|\*|_/g, (match) => {
    const depth = emphasisDepth.get(match) ?? 0;
    emphasisDepth.set(match, depth + 1);
    return { raw: match, role: depth % 2 === 0 ? 'open' : 'close' };
  }); // 必须最后做

  return { masked: out, values };
}

function maskIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(MASK_RE)) {
    ids.add(match[1]);
  }
  return ids;
}

/**
 * 译文是否安全可回填：占位符必须一个不少、序号对得上，且语言方向要对。
 */
export function isSafeTranslation(
  masked: string,
  translated: string,
  direction: Direction = 'from-zh',
): boolean {
  const expected = maskIds(masked);
  const actual = maskIds(translated);
  if (actual.size !== expected.size) {
    return false;
  }
  for (const id of expected) {
    if (!actual.has(id)) {
      return false;
    }
  }

  if (direction === 'from-zh') {
    // 从中文译出：译文里不该再出现中文，出现说明没翻
    return !CJK_RE.test(translated);
  }
  if (direction === 'to-zh') {
    // 译入中文：和原文一模一样说明引擎原样返回了
    return translated.trim() !== masked.trim();
  }
  return true;
}

function renderValue(value: MaskValue, translations: string[], direction: Direction): string {
  if (value.url !== undefined) {
    const candidate =
      value.labelIndex !== undefined ? (translations[value.labelIndex] ?? '').trim() : '';
    const usable =
      candidate.length > 0 &&
      (direction === 'to-zh' ? hasSourceText(candidate, 'from-zh') : !hasSourceText(candidate, direction));
    const label = usable ? candidate : (value.label ?? '');
    return `[${label}](${value.url})`;
  }
  return value.raw;
}

/**
 * 把占位符换回原始片段。
 *
 * 翻译引擎会在占位符周围补空格，如果直接还原会得到 `** sample **` —— 这种前后都有空格的
 * 强调标记在 CommonMark 里不会被识别为粗体。所以开标记吃掉右侧空格、闭标记吃掉左侧空格，
 * 让 `**` 和它包裹的文字紧贴，外侧空格保留。
 */
function unmask(
  text: string,
  values: MaskValue[],
  translations: string[],
  direction: Direction,
): string {
  const joined = text.replace(
    /(\s*)XQ(\d+)QX(\s*)/g,
    (match, lead: string, index: string, trail: string) => {
      const value = values[Number(index)];
      if (!value) {
        return match;
      }
      const replacement = renderValue(value, translations, direction);
      if (value.role === 'open') {
        return lead + replacement;
      }
      if (value.role === 'close') {
        return replacement + trail;
      }
      return lead + replacement + trail;
    },
  );

  if (direction !== 'to-zh') {
    return joined;
  }

  // 中文语境里 `**示例**` 两侧多出来的空格读起来别扭，收掉（只处理紧挨中文的情况，不碰英文）
  return joined
    .replace(/(?<=[\u4e00-\u9fff])\s+(?=(?:\*\*|__|~~|\*|_))/g, '')
    .replace(/((?:\*\*|__|~~|\*|_))\s+(?=[\u4e00-\u9fff])/g, '$1');
}

/**
 * 扫描整篇 Markdown，切出需要翻译的行内文本。
 */
export function planSegments(source: string, direction: Direction = 'from-zh'): SegmentPlan {
  const lines = source.split(/\r\n|\r|\n/);
  const segments: MarkdownSegment[] = [];
  const texts: string[] = [];
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) {
        fence = marker;
      } else if (fence === marker) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      continue;
    }

    if (!hasSourceText(line, direction)) {
      continue;
    }
    if (
      TABLE_DIVIDER_RE.test(line) ||
      HR_RE.test(line) ||
      LINK_DEF_RE.test(line) ||
      COMMENT_RE.test(line)
    ) {
      continue;
    }

    const prefix = PREFIX_RE.exec(line)?.[1] ?? '';
    const body = line.slice(prefix.length);
    if (!hasSourceText(body, direction)) {
      continue;
    }

    const { masked, values } = maskInline(body);
    const hasBodyText = hasSourceText(masked.replace(MASK_RE, ' '), direction);
    const hasLinkLabel = values.some(
      (value) =>
        value.url !== undefined &&
        Boolean(value.label) &&
        hasSourceText(value.label ?? '', direction),
    );
    // 整行只有链接（例如 `- [官网](url)`）时没有正文，但链接文字仍需翻译
    if (!hasBodyText && !hasLinkLabel) {
      continue;
    }

    const segment: MarkdownSegment = { line: i, prefix, masked, values };
    if (hasBodyText) {
      segment.textIndex = texts.length;
      texts.push(masked);
    }
    segments.push(segment);
  }

  // 第二遍：把链接文字排到 texts 尾部，回填时按同样顺序取用
  for (const segment of segments) {
    for (const value of segment.values) {
      if (value.url === undefined || !value.label || !hasSourceText(value.label, direction)) {
        continue;
      }
      value.labelIndex = texts.length;
      texts.push(value.label);
    }
  }

  return { lines, segments, texts };
}

/** 块类型决定双语视图里它要不要做「原文 + 译文」双份。 */
export type BlockKind = 'code' | 'heading' | 'table' | 'text';

export function classifyBlock(block: string): BlockKind {
  const head = block.trimStart();
  if (/^(`{3,}|~{3,})/.test(head)) {
    return 'code';
  }
  if (/^#{1,6}\s/.test(head)) {
    return 'heading';
  }
  if (/^\|/.test(head)) {
    return 'table';
  }
  return 'text';
}

/**
 * 按「块」切分 Markdown：空行分隔，围栏代码块内部的空行不算。
 * 用于双语对照视图 —— 原文块和译文块一一对应。
 */
export function splitBlocks(source: string): string[] {
  const lines = source.split(/\r\n|\r|\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (current.length > 0) {
      blocks.push(current.join('\n'));
      current = [];
    }
  };

  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) {
        fence = marker;
      } else if (fence === marker) {
        fence = null;
      }
      current.push(line);
      continue;
    }
    if (fence !== null) {
      current.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush();
    } else {
      current.push(line);
    }
  }
  flush();
  return blocks;
}

/**
 * 用译文重建整篇 Markdown。翻译结果校验不过的行保留原文。
 *
 * @param translations 与 planSegments(source, direction).texts 一一对应
 */
export function buildTranslatedMarkdown(
  source: string,
  translations: string[],
  direction: Direction = 'from-zh',
): { content: string; applied: number; total: number; rejected: number[] } {
  const { lines, segments } = planSegments(source, direction);
  const output = lines.slice();
  const rejected: number[] = [];
  let applied = 0;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const translated =
      segment.textIndex !== undefined ? translations[segment.textIndex] : segment.masked;
    const text = typeof translated === 'string' ? translated.trim() : '';

    if (segment.textIndex !== undefined) {
      if (!text || !isSafeTranslation(segment.masked, text, direction)) {
        rejected.push(i);
        continue;
      }
      output[segment.line] = segment.prefix + unmask(text, segment.values, translations, direction);
    } else {
      // 纯链接行：没有正文可翻，直接用原文遮罩串还原（链接文字取译文）
      output[segment.line] =
        segment.prefix + unmask(segment.masked, segment.values, translations, direction);
    }
    applied += 1;
  }

  return { content: output.join('\n'), applied, total: segments.length, rejected };
}
