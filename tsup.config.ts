import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node18',
    splitting: false,
    treeshake: true,
  },
  {
    entry: ['src/shell.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    target: 'es2022',
    splitting: false,
    treeshake: true,
  },
]);
