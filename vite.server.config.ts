import { defineConfig } from 'vite';

// Bundles the API server and all its npm dependencies into one file (release/…/server.mjs),
// so the deployed package needs only Node.js – no npm install, no internet.
export default defineConfig({
  build: {
    ssr: 'server/index.ts',
    outDir: 'build/server',
    emptyOutDir: true,
    minify: false,
    target: 'node22',
    rolldownOptions: { output: { entryFileNames: 'server.mjs', codeSplitting: false } },
  },
  ssr: { noExternal: true, target: 'node' },
});
