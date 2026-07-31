import type { ConfigEnv, UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { InlineConfig } from 'vitest';

const config = ({ mode }: ConfigEnv): UserConfig & { test: InlineConfig } => ({
  root: 'web-editor',
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode === 'test' ? 'test' : 'production'),
  },
  build: {
    outDir: '../web-dist/editor',
    emptyOutDir: true,
    lib: {
      entry: 'src/main.tsx',
      formats: ['es'],
      fileName: () => 'editor.js',
      cssFileName: 'editor',
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});

export default config;
