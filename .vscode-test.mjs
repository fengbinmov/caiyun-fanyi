import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'test/**/*.test.js',
  version: 'stable',
  extensionDevelopmentPath: '.',
  mocha: {
    timeout: 60000,
    ui: 'tdd',
  },
});
