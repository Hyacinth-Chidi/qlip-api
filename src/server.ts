import Fastify from 'fastify';
import cors from '@fastify/cors';
import { extractRoute } from './routes/extract.js';
import { downloadRoute } from './routes/download.js';

const PORT = Number(process.env.PORT ?? 4477);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = Fastify({
  logger:
    process.env.NODE_ENV === 'production'
      ? true
      : { transport: { target: 'pino-pretty' } },
});

await app.register(cors, { origin: true });

app.get('/health', async () => ({ ok: true }));

await app.register(extractRoute);
await app.register(downloadRoute);

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
