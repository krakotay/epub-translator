import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
// import { visualizer } from 'rollup-plugin-visualizer'

// https://vite.dev/config/
export default defineConfig({
  base: '/epub-translator/', // 👈 ВАЖНО
  plugins: [
    react(),
    // visualizer({
    //   open: true,
    //   filename: 'dist/stats.html',
    // }),
  ],
})

