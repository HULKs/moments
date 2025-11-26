import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'https://immich.hulks.dev', // Your real Immich URL
        changeOrigin: true,
        secure: false,
        // rewrite is not needed here because Immich expects /api prefix
      }
    }
  }
});
