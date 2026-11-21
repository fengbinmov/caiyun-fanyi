import * as vscode from 'vscode';

/** Token 在 SecretStorage 里的键名。 */
export const TOKEN_SECRET_KEY = 'caiyunFanyi.token';

export const DEFAULT_ENDPOINT = 'https://api.interpreter.caiyunai.com/v1/translator';

/** 优先读加密存储，其次读设置里的兜底字段。 */
export async function resolveToken(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const secret = await context.secrets.get(TOKEN_SECRET_KEY);
  if (secret?.trim()) {
    return secret.trim();
  }
  const fromConfig = vscode.workspace.getConfiguration('caiyunFanyi').get<string>('token');
  return fromConfig?.trim() || undefined;
}
