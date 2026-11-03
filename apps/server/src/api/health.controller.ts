import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { Public } from '../auth/auth.guard';
import { type Db, InjectDb, REDIS_PUB } from '../infra/infra.module';

@Controller('healthz')
export class HealthController {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(REDIS_PUB) private readonly redis: Redis,
  ) {}

  @Public()
  @Get()
  async health() {
    await this.db.execute(sql`SELECT 1`);
    await this.redis.ping();
    return { ok: true, role: process.env.ROLE ?? 'all' };
  }
}
