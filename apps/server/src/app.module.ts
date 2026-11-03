import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { GithubAppClient } from './github/app-client';
import { OfficeController } from './api/office.controller';
import { AdminController } from './api/admin.controller';
import { DashboardController } from './api/dashboard.controller';
import { HealthController } from './api/health.controller';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { SessionService } from './auth/session.service';
import { GithubWebhookController } from './github/github-webhook.controller';
import { IdentityService } from './identity/identity.service';
import { InfraModule } from './infra/infra.module';
import { BACKFILL_QUEUE, NORMALIZE_QUEUE } from './infra/queues';
import { MetricsService } from './metrics/metrics.service';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { BackfillProcessor } from './worker/backfill.processor';
import { NormalizeProcessor } from './worker/normalize.processor';
import { PollScheduler } from './worker/poll.scheduler';
import { OutboxRelay } from './worker/outbox.relay';

/**
 * One codebase, two process roles:
 *   api    — HTTP (webhooks, REST) + Socket.IO
 *   worker — queue processors, outbox relay, sweeper
 *   all    — both, for local development and small deployments
 */
@Module({})
export class AppModule {
  static forRole(role: 'api' | 'worker' | 'all'): DynamicModule {
    const api = role === 'api' || role === 'all';
    const worker = role === 'worker' || role === 'all';
    const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
    return {
      module: AppModule,
      imports: [
        InfraModule,
        ScheduleModule.forRoot(),
        BullModule.forRoot({
          prefix: process.env.REDIS_PREFIX ?? 'workforce',
          connection: {
            host: redisUrl.hostname,
            port: Number(redisUrl.port || 6379),
            password: redisUrl.password || undefined,
            username: redisUrl.username || undefined,
            tls: redisUrl.protocol === 'rediss:' ? {} : undefined,
            maxRetriesPerRequest: null,
          },
        }),
        BullModule.registerQueue({ name: NORMALIZE_QUEUE }, { name: BACKFILL_QUEUE }),
      ],
      controllers: api ? [HealthController, AuthController, GithubWebhookController, DashboardController, AdminController, OfficeController] : [HealthController],
      providers: [
        GithubAppClient,
        SessionService,
        IdentityService,
        MetricsService,
        { provide: APP_GUARD, useClass: AuthGuard },
        ...(api ? [RealtimeGateway] : []),
        ...(worker ? [NormalizeProcessor, BackfillProcessor, OutboxRelay, PollScheduler] : []),
      ],
    };
  }
}
