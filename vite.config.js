import { defineConfig, loadEnv } from 'vite';

// In dev, /api/read-chart runs the same handler file that Vercel deploys.
// The key comes from the git-ignored local env file into this process only.
const apiRoute = {
  name: 'earshot-api-route',
  configureServer(server) {
    const env = loadEnv('development', import.meta.dirname, '');
    for (const name of ['ANTHROPIC_API_KEY']) {
      if (env[name] && !process.env[name]) process.env[name] = env[name];
    }
    server.middlewares.use('/api/read-chart', async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
      const shim = {
        status(code) { res.statusCode = code; return shim; },
        json(obj) {
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(obj));
        },
      };
      try {
        const mod = await server.ssrLoadModule('/api/read-chart.js');
        await mod.default(req, shim);
      } catch {
        shim.status(500).json({ ok: false, error: 'dev' });
      }
    });
  },
};

export default defineConfig({
  plugins: [apiRoute],
});
