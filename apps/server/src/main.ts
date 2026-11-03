import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRole(env.ROLE), {
    rawBody: true, // webhook signatures must be computed over the exact bytes GitHub sent
    bufferLogs: false,
  });
  app.useBodyParser('json', { limit: '25mb' }); // GitHub caps webhook payloads at 25 MB
  app.set('trust proxy', 1);
  app.enableCors({ origin: env.WEB_ORIGIN, credentials: true });
  app.enableShutdownHooks();

  if (env.ROLE === 'worker') {
    await app.init(); // no HTTP routes beyond health; still listen so orchestrators can probe it
    await app.listen(env.PORT + 1);
  } else {
    await app.listen(env.PORT);
  }
  new Logger('Bootstrap').log(`Live Workforce server started (role=${env.ROLE}, port=${env.ROLE === 'worker' ? env.PORT + 1 : env.PORT})`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
