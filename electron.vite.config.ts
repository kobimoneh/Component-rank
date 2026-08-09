import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // node:sqlite is loaded via createRequire in src/db/driver.ts, but keep it
        // external here too so nothing tries to inline a builtin.
        external: ['node:sqlite'],
        input: { index: resolve('src/main/index.ts') },
        // CommonJS main, the conventional Electron form. (Note for anyone
        // debugging a bare `electron.app is undefined`: check whether
        // ELECTRON_RUN_AS_NODE is set in your shell. It makes the binary run as
        // plain Node, so `require('electron')` returns an empty object.)
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // Preload must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@domain': resolve('src/domain'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
})
