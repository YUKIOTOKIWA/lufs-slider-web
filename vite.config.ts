import { defineConfig } from 'vite'

// Portable dist: assets and worker/worklet modules resolve under the page's path.
export default defineConfig({ base: './' })
