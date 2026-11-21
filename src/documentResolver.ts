import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * 解析出要处理的 Markdown 文档。
 * 命令可能来自编辑器标题栏（带 uri）、资源管理器右键（带 uri）、命令面板（无 uri），
 * 也可能来自内置 Markdown 预览的标题栏（webview 面板，拿不到 uri）。
 */
export async function resolveMarkdownDocument(
  uri?: vscode.Uri,
): Promise<vscode.TextDocument | undefined> {
  if (uri) {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      if (document.languageId === 'markdown') {
        return document;
      }
    } catch {
      /* 落到下面的兜底逻辑 */
    }
  }

  const active = vscode.window.activeTextEditor?.document;
  if (active?.languageId === 'markdown') {
    return active;
  }

  // 活动标签可能是 webview（内置预览），普通文本标签则能直接取到 uri
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input as { uri?: vscode.Uri } | undefined;
  if (input?.uri) {
    try {
      const document = await vscode.workspace.openTextDocument(input.uri);
      if (document.languageId === 'markdown') {
        return document;
      }
    } catch {
      /* 忽略 */
    }
  }

  const visible = vscode.workspace.textDocuments.find(
    (document) =>
      document.languageId === 'markdown' && document.uri.scheme !== 'caiyun-fanyi-translated',
  );

  // 内置 Markdown 预览的标签页标题就是文件名，用它去匹配已打开的文档最准
  if (tab?.label) {
    const sameName = vscode.workspace.textDocuments.filter(
      (document) =>
        document.languageId === 'markdown' &&
        document.uri.scheme !== 'caiyun-fanyi-translated' &&
        path.basename(document.fileName) === tab.label,
    );
    if (sameName.length === 1) {
      return sameName[0];
    }
  }

  if (visible) {
    return visible;
  }

  // 最后按标签页标题（文件名）在工作区里找唯一匹配
  if (tab?.label && /\.(md|markdown|mdx)$/i.test(tab.label) && !/[*?[\]{}]/.test(tab.label)) {
    try {
      const matches = await vscode.workspace.findFiles(`**/${tab.label}`, '**/node_modules/**', 5);
      if (matches.length === 1) {
        const document = await vscode.workspace.openTextDocument(matches[0]);
        if (document.languageId === 'markdown') {
          return document;
        }
      }
    } catch {
      /* 忽略 */
    }
  }

  return undefined;
}
