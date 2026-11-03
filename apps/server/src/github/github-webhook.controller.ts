import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  type RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Request } from 'express';
import { Public } from '../auth/auth.guard';
import { type Db, type Env, InjectDb, InjectEnv } from '../infra/infra.module';
import { NORMALIZE_QUEUE, normalizeJobOptions } from '../infra/queues';
import { insertRawIfNew } from '../ingestion/raw-store';
import { verifyGithubSignature } from './verify';

/**
 * Verify → store raw → enqueue → 202. Nothing else happens in the request,
 * so GitHub always gets a fast answer and no delivery is lost if processing fails.
 */
@Controller('webhooks/github')
export class GithubWebhookController {
  private readonly log = new Logger('GithubWebhook');

  constructor(
    @InjectDb() private readonly db: Db,
    @InjectEnv() private readonly env: Env,
    @InjectQueue(NORMALIZE_QUEUE) private readonly queue: Queue,
  ) {}

  @Public()
  @Post()
  @HttpCode(202)
  async receive(@Req() req: RawBodyRequest<Request>, @Headers() h: Record<string, string>) {
    const deliveryId = h['x-github-delivery'];
    const eventType = h['x-github-event'];
    if (!req.rawBody || !deliveryId || !eventType) throw new BadRequestException('Not a GitHub webhook');
    if (!verifyGithubSignature(req.rawBody, h['x-hub-signature-256'], this.env.GITHUB_WEBHOOK_SECRET)) {
      this.log.warn(`Rejected delivery ${deliveryId}: bad signature`);
      throw new UnauthorizedException('Invalid signature');
    }
    if (this.env.GITHUB_APP_ID && this.env.GITHUB_ORG && (req.body.installation?.account?.login ?? req.body.repository?.owner?.login ?? req.body.organization?.login)?.toLowerCase() !== this.env.GITHUB_ORG.toLowerCase() && eventType !== 'ping') throw new UnauthorizedException('Organization is not connected');
    if (eventType === 'ping') return { ok: true, pong: true };

    const rawId = await insertRawIfNew(this.db, {
      source: 'GITHUB',
      externalEventId: deliveryId,
      eventType,
      payload: req.body,
    });
    if (rawId) {
      // If Redis is briefly down the raw row stays PENDING and the sweeper re-enqueues it.
      await this.queue.add('github', { rawId }, normalizeJobOptions(rawId)).catch((err) => {
        this.log.error(`Enqueue failed for ${rawId}: ${err}`);
      });
    }
    return { ok: true, duplicate: !rawId };
  }
}
