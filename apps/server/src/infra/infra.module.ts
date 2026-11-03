import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import type { Pool } from 'pg';
import { loadEnv, type Env } from '../config/env';
import { createDb, type Db } from '../db/db';

export const ENV = Symbol('ENV');
export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');
export const REDIS_PUB = Symbol('REDIS_PUB');
export const REDIS_SUB = Symbol('REDIS_SUB');

export const InjectDb = () => Inject(DB);
export const InjectEnv = () => Inject(ENV);

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL, 15);

@Global()
@Module({
  providers: [
    { provide: ENV, useValue: env },
    { provide: DB, useValue: db },
    { provide: PG_POOL, useValue: pool },
    { provide: REDIS_PUB, useFactory: () => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }) },
    { provide: REDIS_SUB, useFactory: () => new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }) },
  ],
  exports: [ENV, DB, PG_POOL, REDIS_PUB, REDIS_SUB],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pg: Pool,
    @Inject(REDIS_PUB) private readonly pub: Redis,
    @Inject(REDIS_SUB) private readonly sub: Redis,
  ) {}

  async onApplicationShutdown() {
    this.pub.disconnect();
    this.sub.disconnect();
    await this.pg.end();
  }
}

export type { Db, Env };
