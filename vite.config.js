import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// /prompt (no trailing slash) serves the prompt page in dev, as it does on Vercel.
const promptRoute = {
  name: 'earshot-prompt-route',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/prompt' || req.url.startsWith('/prompt?')) req.url = '/prompt/index.html';
      next();
    });
  },
};

export default defineConfig({
  plugins: [promptRoute],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        prompt: resolve(import.meta.dirname, 'prompt/index.html'),
      },
    },
  },
});
