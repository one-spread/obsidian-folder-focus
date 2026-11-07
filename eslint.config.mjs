import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
export default defineConfig([
  globalIgnores(['node_modules/**', 'main.js', 'esbuild.config.mjs', 'eslint.config.mjs', 'tests/**', 'docs/**']),
  ...obsidianmd.configs.recommended,
  { files: ['**/*.ts'], languageOptions: { parserOptions: { projectService: true } } },
]);
