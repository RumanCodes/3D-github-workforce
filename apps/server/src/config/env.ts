import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** Namespaces queues and the realtime channel, so two deployments can share one Redis safely. */
  REDIS_PREFIX: z.string().regex(/^[\w-]+$/).default('workforce'),
  PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  GITHUB_WEBHOOK_SECRET: z.string().min(8, 'GITHUB_WEBHOOK_SECRET must be at least 8 characters'),
  GITHUB_POLL_ENABLED: z.string().default('false').transform(v => v === 'true'),
  GITHUB_APP_ID: z.string().default(''),
  GITHUB_APP_PRIVATE_KEY: z.string().default(''),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().default(''),
  GITHUB_TOKEN: z.string().optional().default(''),
  GITHUB_ORG: z.string().optional().default(''),
  GITHUB_OAUTH_CLIENT_ID: z.string().optional().default(''),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().optional().default(''),
  BOOTSTRAP_ADMIN_LOGINS: z.string().optional().default(''),
  DEV_AUTH: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  NODE_ENV: z.string().default('development'),
});

export type Env = z.infer<typeof EnvSchema>;

/** Loads apps/server/.env (if present) without overriding real environment variables. */
export function loadEnv(): Env {
  const file = path.join(__dirname, '..', '..', '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
  const env = EnvSchema.parse(process.env);
  if (!env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_PRIVATE_KEY_PATH) {
    env.GITHUB_APP_PRIVATE_KEY = fs.readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, 'utf8');
  }
  if (env.DEV_AUTH && env.NODE_ENV === 'production') {
    throw new Error('DEV_AUTH must not be enabled in production');
  }
  return env;
}
