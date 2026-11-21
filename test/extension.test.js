const assert = require('node:assert');
const path = require('node:path');
const vscode = require('vscode');

const VIEW_TYPE = 'caiyunFanyi.translated';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findExtension() {
  const extension = vscode.extensions.all.find((item) =>
    item.packageJSON?.contributes?.customEditors?.some((editor) => editor.viewType === VIEW_TYPE),
  );
  assert.ok(extension, '找不到扩展');
  return extension;
}

async function openFixture() {
  const extension = findExtension();
  await extension.activate();

  const file = path.join(extension.extensionPath, 'examples', 'demo.md');
  const document = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
  await delay(300);
  return document;
}

suite('彩云翻译', () => {
  suiteSetup(async () => {
    // 命令是在 activate 里注册的，必须先激活再查命令表
    await findExtension().activate();
  });

  test('命令已注册', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'caiyunFanyi.showTranslatedPreview',
      'caiyunFanyi.toggleTranslatedPreview',
      'caiyunFanyi.showSourcePreview',
      'caiyunFanyi.setToken',
    ]) {
      assert.ok(commands.includes(id), `缺少命令 ${id}`);
    }
  });

  test('不注册默认快捷键（避免和其他扩展抢键位）', () => {
    const keybindings = findExtension().packageJSON?.contributes?.keybindings;
    assert.strictEqual(keybindings, undefined, '不应存在默认快捷键');
  });

  test('切换译文：原地替换成自定义编辑器，标签数量不变', async () => {
    await openFixture();
    const group = vscode.window.tabGroups.activeTabGroup;
    const beforeCount = group.tabs.length;
    const beforeTab = group.activeTab;

    await vscode.commands.executeCommand('caiyunFanyi.showTranslatedPreview');
    await delay(1200);

    const afterGroup = vscode.window.tabGroups.activeTabGroup;
    const input = afterGroup.activeTab?.input;

    assert.ok(input instanceof vscode.TabInputCustom, '活动标签应该是自定义编辑器');
    assert.strictEqual(input.viewType, VIEW_TYPE);
    assert.strictEqual(
      afterGroup.tabs.length,
      beforeCount,
      `标签数量应保持不变（切换前 ${beforeCount}，切换后 ${afterGroup.tabs.length}）`,
    );
    assert.ok(beforeTab, '切换前应该有活动标签');
  });

  test('再切换一次：回到文本编辑器，仍然原地', async () => {
    const group = vscode.window.tabGroups.activeTabGroup;
    const beforeCount = group.tabs.length;

    await vscode.commands.executeCommand('caiyunFanyi.toggleTranslatedPreview');
    await delay(1200);

    const afterGroup = vscode.window.tabGroups.activeTabGroup;
    const input = afterGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputText, '应该切回文本编辑器');
    assert.strictEqual(afterGroup.tabs.length, beforeCount, '标签数量应保持不变');
  });

  test('切换双语：原地替换成双语视图，标签数量不变', async () => {
    await openFixture();
    const group = vscode.window.tabGroups.activeTabGroup;
    const beforeCount = group.tabs.length;

    await vscode.commands.executeCommand('caiyunFanyi.showBilingualPreview');
    await delay(1800);

    const afterGroup = vscode.window.tabGroups.activeTabGroup;
    const input = afterGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputCustom, '活动标签应该是自定义编辑器');
    assert.strictEqual(input.viewType, 'caiyunFanyi.bilingual');
    assert.strictEqual(afterGroup.tabs.length, beforeCount, '标签数量应保持不变');
  });

  test('双语视图切回文本编辑器，仍然原地', async () => {
    const group = vscode.window.tabGroups.activeTabGroup;
    const beforeCount = group.tabs.length;

    await vscode.commands.executeCommand('caiyunFanyi.toggleTranslatedPreview');
    await delay(1500);

    const afterGroup = vscode.window.tabGroups.activeTabGroup;
    assert.ok(afterGroup.activeTab?.input instanceof vscode.TabInputText, '应该切回文本编辑器');
    assert.strictEqual(afterGroup.tabs.length, beforeCount, '标签数量应保持不变');
  });
});
