import * as vscode from 'vscode';
import { resolveMarkdownDocument } from './documentResolver';
import { TOKEN_SECRET_KEY } from './preview';
import {
  BILINGUAL_EDITOR_VIEW_TYPE,
  TRANSLATED_EDITOR_VIEW_TYPE,
  TRANSLATED_VIEW_TYPES,
  TranslatedEditorProvider,
} from './translatedEditor';

async function promptForToken(context: vscode.ExtensionContext): Promise<void> {
  const existing = await context.secrets.get(TOKEN_SECRET_KEY);
  const value = await vscode.window.showInputBox({
    title: '彩云小译 API Token',
    prompt: existing
      ? '已保存 Token，输入新值将覆盖；直接回车（留空）可清除。'
      : '在彩云小译开放平台控制台获取 Token，粘贴后回车保存。',
    placeHolder: '粘贴 Token',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    await context.secrets.delete(TOKEN_SECRET_KEY);
    void vscode.window.showInformationMessage('已清除彩云小译 Token。');
    return;
  }
  await context.secrets.store(TOKEN_SECRET_KEY, trimmed);
  void vscode.window.showInformationMessage('已保存彩云小译 Token。');
}

export function activate(context: vscode.ExtensionContext): void {

  // ---------------------------------------------------------------- 命令
  /**
   * 当前活动编辑器是不是这篇 Markdown（文本编辑器 或 内置预览）。
   * 是的话就可以直接原地换 viewType，不需要先打开文档 —— 那个动作本身会新开标签。
   */
  const activeEditorKind = (
    input: vscode.Tab['input'],
  ): 'markdown' | 'builtin-preview' | 'translated' | 'other' => {
    if (input instanceof vscode.TabInputCustom) {
      return TRANSLATED_VIEW_TYPES.includes(input.viewType) ? 'translated' : 'other';
    }
    if (input instanceof vscode.TabInputWebview) {
      return input.viewType === 'markdown.preview' ? 'builtin-preview' : 'other';
    }
    if (input instanceof vscode.TabInputText) {
      const document = vscode.workspace.textDocuments.find(
        (item) => item.uri.toString() === input.uri.toString(),
      );
      return document?.languageId === 'markdown' ? 'markdown' : 'other';
    }
    return 'other';
  };

  /**
   * 把当前编辑器原地切换成指定 viewType。
   *
   * 不能用 `vscode.openWith`：它走的是 editorService.openEditor，对「同一资源 + 不同 viewType」
   * 是**追加新标签**的语义。VS Code 自己的「Reopen With」用的是内部命令
   * `reopenActiveEditorWith`（底层 replaceEditors），才是原地替换。
   *
   * 内部命令的参数格式在不同版本上可能是 viewType 字符串，也可能是 `{ id }`；
   * 而且它对失败不抛错，所以这里逐个试并**验证结果**。
   */
  const isActiveViewType = (viewType: string): boolean => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (viewType === 'default') {
      return input instanceof vscode.TabInputText;
    }
    return input instanceof vscode.TabInputCustom && input.viewType === viewType;
  };

  const switchActiveEditorTo = async (viewType: string): Promise<boolean> => {
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes('reopenActiveEditorWith')) {
      return false;
    }
    for (const argument of [viewType, { id: viewType }]) {
      try {
        await vscode.commands.executeCommand('reopenActiveEditorWith', argument);
      } catch {
        continue;
      }
      // 给 VS Code 一点时间完成切换，再确认真的换了
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (isActiveViewType(viewType)) {
        return true;
      }
    }
    return false;
  };

  /** 关掉当前标签并在同一列打开目标视图。只用于「内置预览」这类派生视图，不碰源文件标签。 */
  const replaceActiveTab = async (uri: vscode.Uri, viewType: string): Promise<boolean> => {
    const group = vscode.window.tabGroups.activeTabGroup;
    const tab = group.activeTab;
    const column = group.viewColumn;
    if (tab) {
      try {
        await vscode.window.tabGroups.close(tab, true);
      } catch {
        return false;
      }
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, viewType, column);
    return true;
  };

  /**
   * 切到译文。
   *
   * 三条路径，按「对布局的破坏程度」从轻到重排：
   *   1. 文本编辑器  → reopenActiveEditorWith 原地替换
   *   2. 内置预览    → 同上；不行就关掉预览再开（预览是派生视图，关了不丢源文件标签）
   *   3. 其他        → 按文档打开
   */
  /**
   * 切换到指定的自定义视图（单语译文 / 双语对照）。
   * 从文本编辑器、内置预览、以及两种自定义视图之间都能原地替换。
   */
  const switchToCustomView = async (viewType: string): Promise<void> => {
    const group = vscode.window.tabGroups.activeTabGroup;
    const input = group.activeTab?.input;

    if (input instanceof vscode.TabInputCustom && input.viewType === viewType) {
      return;
    }

    const kind = activeEditorKind(input);

    // 记下切换前的形态，切回原文时还原（自定义视图之间互切时不覆盖）
    if (kind === 'markdown' || kind === 'builtin-preview') {
      await context.workspaceState.update(
        'caiyunFanyi.previousViewType',
        kind === 'builtin-preview' ? 'markdown.preview' : 'default',
      );
    }

    if (kind === 'markdown' || kind === 'builtin-preview' || kind === 'translated') {
      if (await switchActiveEditorTo(viewType)) {
        return;
      }
    }

    if (kind === 'builtin-preview') {
      const document = await resolveMarkdownDocument();
      if (document && (await replaceActiveTab(document.uri, viewType))) {
        return;
      }
    }

    const document = await resolveMarkdownDocument();
    if (!document || document.languageId !== 'markdown') {
      void vscode.window.showInformationMessage(
        '请先打开一个 Markdown 文件，或在它的编辑器里执行本命令。',
      );
      return;
    }
    await vscode.commands.executeCommand('vscode.openWith', document.uri, viewType);
  };

  const showTranslated = async (): Promise<void> => {
    await switchToCustomView(TRANSLATED_EDITOR_VIEW_TYPE);
  };

  const showBilingual = async (): Promise<void> => {
    await switchToCustomView(BILINGUAL_EDITOR_VIEW_TYPE);
  };

  /** 切回原文：还原到切换前的编辑器形态（文本编辑器或内置预览），同样原地。 */
  const showSource = async (): Promise<void> => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const previous = context.workspaceState.get<string>(
      'caiyunFanyi.previousViewType',
      'default',
    );

    if (activeEditorKind(input) !== 'translated') {
      const document = await resolveMarkdownDocument();
      if (!document) {
        void vscode.window.showInformationMessage('找不到对应的 Markdown 文件。');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      return;
    }

    // 优先还原成切换前的形态；退化到文本编辑器；再不行就换掉译文标签
    if (await switchActiveEditorTo(previous)) {
      return;
    }
    if (previous !== 'default' && (await switchActiveEditorTo('default'))) {
      return;
    }

    const document = await resolveMarkdownDocument();
    if (document) {
      await replaceActiveTab(document.uri, previous);
    }
  };

  /** 当前标签如果是译文视图就切回原文，否则切到译文。 */
  const toggleTranslated = async (): Promise<void> => {
    if (
      activeEditorKind(vscode.window.tabGroups.activeTabGroup.activeTab?.input) === 'translated'
    ) {
      await showSource();
      return;
    }
    await showTranslated();
  };

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      TRANSLATED_EDITOR_VIEW_TYPE,
      new TranslatedEditorProvider(context, 'translated'),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.window.registerCustomEditorProvider(
      BILINGUAL_EDITOR_VIEW_TYPE,
      new TranslatedEditorProvider(context, 'bilingual'),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),

    // 主入口：在当前标签页里切换成译文 / 双语 / 切回原文
    vscode.commands.registerCommand('caiyunFanyi.toggleTranslatedPreview', toggleTranslated),
    vscode.commands.registerCommand('caiyunFanyi.showTranslatedPreview', showTranslated),
    vscode.commands.registerCommand('caiyunFanyi.showBilingualPreview', showBilingual),
    vscode.commands.registerCommand('caiyunFanyi.showSourcePreview', showSource),

    vscode.commands.registerCommand('caiyunFanyi.setToken', () => promptForToken(context)),
  );
}

export function deactivate(): void {
  /* 面板随窗口销毁而释放 */
}
