import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.next/**'],
  },
  // Mirror tsconfig `"@/*": ["./*"]` so tests can import components that use the
  // `@/` alias (e.g. `@/lib/services`). The `^@/` anchor avoids touching scoped
  // npm packages like `@zleap/*`.
  resolve: {
    alias: [{ find: /^@\//u, replacement: `${rootDir}/` }],
  },
});
