import { Inject, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  type OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Server, Socket } from 'socket.io';
import { SessionService } from '../auth/session.service';
import { type Db, InjectDb, REDIS_SUB } from '../infra/infra.module';
import { rtChannel } from '../worker/outbox.relay';

const REPLAY_WINDOW_MIN = 5;
const BATCH_MS = 100;

/**
 * Pushes outbox deltas to signed-in browsers. Each API instance subscribes to Redis, so any number of
 * API replicas can serve sockets. Deltas are batched per room every 100 ms (one emit, many changes).
 * On reconnect, a client sends its last seq and gets what it missed, or is told to refetch.
 */
@WebSocketGateway({
  path: '/rt',
  cors: { origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000', credentials: true },
  transports: ['websocket'],
})
export class RealtimeGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() io!: Server;
  private readonly log = new Logger('Realtime');
  private pending = new Map<string, unknown[]>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly sessions: SessionService,
    @InjectDb() private readonly db: Db,
    @Inject(REDIS_SUB) private readonly sub: Redis,
  ) {}

  async handleConnection(socket: Socket) {
    const user = await this.sessions.userFromCookieHeader(socket.handshake.headers.cookie);
    if (!user) {
      socket.emit('unauthorized');
      socket.disconnect(true);
      return;
    }
    socket.data.user = user;
    // Every signed-in employee can see org-wide work activity; individual metrics go through the REST API's checks.
    await socket.join('org');

    const lastSeq = Number(socket.handshake.auth?.lastSeq ?? 0);
    if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) { socket.emit('resync'); socket.emit('ready'); return; }
    if (lastSeq >= 0) {
      const rows = (
        await this.db.execute<any>(sql`
          SELECT id, payload FROM outbox
          WHERE id > ${lastSeq} AND topic = 'org'
          ORDER BY id LIMIT 501`)
      ).rows;
      const oldest = (await this.db.execute<any>(sql`SELECT min(id) AS id FROM outbox`)).rows[0]?.id;
      const gap = oldest !== null && Number(oldest) > lastSeq + 1;
      if (rows.length > 500 || gap) socket.emit('resync');
      else if (rows.length) socket.emit('replay', rows.map((r) => ({ ...r.payload, seq: Number(r.id) })));
    }
    socket.emit('ready');
  }

  async onModuleInit() {
    await this.sub.subscribe(rtChannel());
    this.sub.on('message', (_channel, raw) => {
      try {
        const { topic, msg } = JSON.parse(raw);
        const list = this.pending.get(topic) ?? [];
        list.push(msg);
        this.pending.set(topic, list);
      } catch (err) {
        this.log.warn(`bad realtime message: ${err}`);
      }
    });
    this.timer = setInterval(() => {
      if (!this.pending.size || !this.io) return;
      for (const [topic, batch] of this.pending) this.io.to(topic).emit('deltas', batch);
      this.pending.clear();
    }, BATCH_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
