import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import {
  buildTranslatedMarkdown,
  hashString,
  planSegments,
  resolveDirection,
  splitBlocks,
} from './markdownTranslator';
import { DEFAULT_ENDPOINT, resolveToken } from './preview';
import { translateTexts } from './translator';

/**
 * 译文编辑器的 viewType。
 *
 * 关键：自定义编辑器绑定的是**源文件自己的 URI**，切换 viewType 就是 VS Code 的
 * 「Reopen Editor With」——同一个标签页原地换渲染方式，既不新开标签，也不用关闭任何标签。
 */
export const TRANSLATED_EDITOR_VIEW_TYPE = 'caiyunFanyi.translated';

/** 双语对照视图的 viewType。 */
export const BILINGUAL_EDITOR_VIEW_TYPE = 'caiyunFanyi.bilingual';

/** 两种视图的 viewType 集合，用于判断「当前是不是我们的编辑器」。 */
export const TRANSLATED_VIEW_TYPES: readonly string[] = [
  TRANSLATED_EDITOR_VIEW_TYPE,
  BILINGUAL_EDITOR_VIEW_TYPE,
];

type EditorMode = 'translated' | 'bilingual';

/** 内置 Markdown 扩展导出的渲染命令，输出与原生预览完全一致（含代码高亮、KaTeX）。 */
const BUILTIN_RENDER_COMMAND = 'markdown.api.render';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把字体名里的尖括号/分号挡掉，避免把 style 标签闭合掉。 */
function escapeStyle(value: string): string {
  return value.replace(/[<>{};]/g, '');
}

export class TranslatedEditorProvider implements vscode.CustomTextEditorProvider {
  /** 译文缓存：源文档 URI → { 内容指纹, 译文 }。只活在内存里，重载窗口即清空。 */
  private readonly cache = new Map<string, { hash: string; content: string }>();
  /** 渲染结果缓存：同一段 Markdown 只渲染一次（原文块基本不变，能省掉大量命令调用）。 */
  private readonly htmlCache = new Map<string, string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly mode: EditorMode = 'translated',
  ) {}

  /**
   * 交给 VS Code 内置的 Markdown 渲染器，不再自己打包 markdown-it / highlight.js。
   * 输出与原生预览逐字一致，并自带语法高亮和 KaTeX；成本只是一次命令调用。
   */
  private async renderMarkdown(source: string): Promise<string> {
    const cached = this.htmlCache.get(source);
    if (cached !== undefined) {
      return cached;
    }
    let html = '';
    try {
      const result = await vscode.commands.executeCommand<string>(
        BUILTIN_RENDER_COMMAND,
        source,
      );
      html = typeof result === 'string' ? result : `<pre>${escapeHtml(source)}</pre>`;
    } catch {
      html = `<pre>${escapeHtml(source)}</pre>`;
    }
    this.htmlCache.set(source, html);
    return html;
  }

  /**
   * 逐段对照。
   *
   * 阅读主体是**原文**，译文是辅助 —— 所以原文正常字号、正常颜色，译文小一号且淡色。
   * 只要这块被翻译过就双份（段落、列表、引用、标题、表格都算）；
   * 翻译前后一模一样的块（代码、图片、本来已是中文的段落）只留一份。
   */
  private async renderPairs(source: string, translated: string): Promise<string> {
    const sourceBlocks = splitBlocks(source);
    const translatedBlocks = splitBlocks(translated);
    const total = Math.max(sourceBlocks.length, translatedBlocks.length);
    const parts: string[] = [];

    for (let i = 0; i < total; i += 1) {
      const original = sourceBlocks[i] ?? '';
      const chinese = translatedBlocks[i] ?? original;

      // 没被翻译的块：只留一份
      if (chinese === original) {
        parts.push(
          `<div class="pair pair-single">${await this.renderMarkdown(original)}</div>`,
        );
        continue;
      }

      const originalHtml = await this.renderMarkdown(original);
      const translatedHtml = await this.renderMarkdown(chinese);
      parts.push(
        `<div class="pair pair-double"><div class="pair-src">${originalHtml}</div>` +
          `<div class="pair-tl">${translatedHtml}</div></div>`,
      );
    }

    return parts.join('\n');
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        ...(document.uri.scheme === 'file' ? [vscode.Uri.joinPath(document.uri, '..')] : []),
      ],
    };

    // 先把原文渲染出来，翻译在后台跑，不用等
    const sourceText = document.getText();
    const initialBody =
      this.mode === 'bilingual'
        ? await this.renderPairs(sourceText, sourceText)
        : await this.renderMarkdown(sourceText);
    webview.html = this.buildHtml(webview, document, initialBody);

    const controller = new AbortController();
    const disposables: vscode.Disposable[] = [];
    panel.onDidDispose(
      () => {
        controller.abort();
        disposables.forEach((item) => item.dispose());
      },
      undefined,
      disposables,
    );
    token.onCancellationRequested(() => controller.abort());

    webview.onDidReceiveMessage(
      async (message: { type?: string; href?: string }) => {
        if (message.type === 'openLink' && message.href) {
          await this.openLink(document, message.href);
        }
      },
      undefined,
      disposables,
    );

    void this.runTranslation(document, webview, controller.signal);
  }

  // ---------------------------------------------------------------- 翻译

  private async runTranslation(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    signal: AbortSignal,
  ): Promise<void> {
    const source = document.getText();
    const config = vscode.workspace.getConfiguration('caiyunFanyi');
    const endpoint = config.get<string>('endpoint') || DEFAULT_ENDPOINT;
    const transType = config.get<string>('transType') || 'en2zh';
    const batchSize = config.get<number>('batchSize') ?? 8;
    const direction = resolveDirection(transType);
    const hash = hashString(`${transType}\u0000${source}`);

    // 渲染是异步的，可能比下一批翻译慢；用一个自增 id 丢弃过期结果，避免旧内容覆盖新内容
    let renderId = 0;
    const renderAndPost = async (markdown: string) => {
      const id = (renderId += 1);
      const html =
        this.mode === 'bilingual'
          ? await this.renderPairs(source, markdown)
          : await this.renderMarkdown(markdown);
      if (id !== renderId) {
        return;
      }
      void webview.postMessage({ type: 'content', html });
    };

    // 命中缓存直接渲染，不调接口
    const cached = this.cache.get(document.uri.toString());
    if (cached && cached.hash === hash) {
      await renderAndPost(cached.content);
      return;
    }

    const plan = planSegments(source, direction);
    if (plan.segments.length === 0) {
      return;
    }

    let token = await resolveToken(this.context);
    if (!token) {
      const choice = await vscode.window.showErrorMessage(
        '未配置彩云小译 API Token，无法翻译。',
        '设置 Token',
      );
      if (choice === '设置 Token') {
        await vscode.commands.executeCommand('caiyunFanyi.setToken');
      }
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: '彩云翻译',
          cancellable: true,
        },
        async (progress, cancelToken) => {
          cancelToken.onCancellationRequested(() => {
            /* signal 由外层 controller 控制 */
          });

          const translations = await translateTexts(plan.texts, {
            token: token as string,
            endpoint,
            transType,
            batchSize,
            signal,
            onBatch: (partial, done, total) => {
              progress.report({ message: `${done}/${total}`, increment: 100 / total });
              void renderAndPost(buildTranslatedMarkdown(source, partial, direction).content);
            },
          });

          const { content, applied, total } = buildTranslatedMarkdown(
            source,
            translations,
            direction,
          );
          await renderAndPost(content);

          if (applied === 0) {
            void vscode.window.showWarningMessage('翻译结果无法安全回填，已显示原文。');
            return;
          }

          // 整篇翻完才写缓存，半成品不落缓存
          this.cache.set(document.uri.toString(), { hash, content });
          if (applied < total) {
            void vscode.window.showWarningMessage(
              `有 ${total - applied} 段未能安全翻译，这些段落保留了原文。`,
            );
          }
        },
      );
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`彩云翻译失败：${message}`);
    }
  }

  // ---------------------------------------------------------------- 链接

  private async openLink(document: vscode.TextDocument, rawHref: string): Promise<void> {
    if (!rawHref || rawHref.startsWith('#')) {
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(rawHref)) {
      try {
        await vscode.env.openExternal(vscode.Uri.parse(rawHref, true));
      } catch {
        /* 忽略 */
      }
      return;
    }
    const clean = rawHref.split('#')[0].split('?')[0];
    let decoded = clean;
    try {
      decoded = decodeURIComponent(clean);
    } catch {
      /* 保留原样 */
    }
    try {
      await vscode.commands.executeCommand(
        'vscode.open',
        vscode.Uri.joinPath(vscode.Uri.joinPath(document.uri, '..'), decoded),
      );
    } catch {
      /* 忽略 */
    }
  }

  // ---------------------------------------------------------------- 页面

  private buildHtml(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    body: string,
  ): string {
    const media = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: http: data:`,
      `media-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} https: data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    const base =
      document.uri.scheme === 'file'
        ? webview.asWebviewUri(vscode.Uri.joinPath(document.uri, '..')).toString()
        : '';
    const baseTag = base ? `<base href="${base.endsWith('/') ? base : `${base}/`}">` : '';

    // 跟随用户对内置 Markdown 预览的字体设置，做到和原生观感一致
    const previewConfig = vscode.workspace.getConfiguration('markdown.preview');
    const fontSize = previewConfig.get<number>('fontSize') ?? 14;
    const lineHeight = Math.round((previewConfig.get<number>('lineHeight') ?? 1.5) * fontSize);
    const fontFamily = previewConfig.get<string>('fontFamily') ?? '';
    const fontStyle = [
      `--markdown-font-size: ${fontSize}px;`,
      `--markdown-line-height: ${lineHeight}px;`,
      fontFamily ? `--markdown-font-family: ${escapeStyle(fontFamily)};` : '',
    ].join(' ');

    // 双语对照：逐段上下排列
    const content =
      this.mode === 'bilingual' ? `<div class="pairs">${body}</div>` : body;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${baseTag}
<style>
:root { ${fontStyle} }
/* 没有打包 KaTeX 样式，至少把重复的 MathML 部分藏起来 */
.katex-mathml { display: none; }

/* 双语对照：原文为主、译文为辅 */
.pair {
  padding: 0.45em 0;
}
/* 只有「需要对照」的块之间才画分隔线，避免满屏横线 */
.pair-double + .pair-double {
  border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18));
}
/* 译文整体小一号、淡一些：读的时候原文是主体，译文用来扫一眼辅助理解 */
.pair .pair-tl {
  margin-top: 0.35em;
  font-size: 0.88em;
  color: var(--vscode-descriptionForeground, rgba(200, 200, 200, 0.85));
}
.pair .pair-tl > :first-child,
.pair .pair-src > :first-child {
  margin-top: 0;
}
.pair .pair-tl > :last-child,
.pair .pair-src > :last-child {
  margin-bottom: 0;
}
</style>
<link rel="stylesheet" href="${media('doc.css')}">
<link rel="stylesheet" href="${media('code.css')}">
</head>
<body data-mode="${this.mode}">
${content}
<script nonce="${nonce}" src="${media('editor.js')}"></script>
</body>
</html>`;
  }
}
