import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { parseBody } from '../common/zod';
import { IdentityService } from '../identity/identity.service';
import { type Db, type Env, InjectDb, InjectEnv } from '../infra/infra.module';
import { CurrentUser, Public } from './auth.guard';
import { type AuthUser, parseCookies, SESSION_COOKIE, SessionService } from './session.service';

const OAUTH_STATE_COOKIE = 'wf_oauth_state';

@Controller('api')
export class AuthController {
  constructor(
    @InjectDb() private readonly db: Db,
    @InjectEnv() private readonly env: Env,
    private readonly sessions: SessionService,
    private readonly identities: IdentityService,
  ) {}

  private setSession(res: Response, token: string, expiresAt: Date) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.env.NODE_ENV === 'production',
      expires: expiresAt,
      path: '/',
    });
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Public()
  @Get('auth/options')
  options() {
    return { github: !!this.env.GITHUB_OAUTH_CLIENT_ID, dev: this.env.DEV_AUTH };
  }

  @Public()
  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.sessions.destroy(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  // ---------- Local development sign-in (disabled unless DEV_AUTH=true; refused in production) ----------

  @Public()
  @Get('auth/dev/users')
  async devUsers() {
    if (!this.env.DEV_AUTH) throw new NotFoundException();
    const r = await this.db.execute<any>(sql`
      SELECT e.id, e.display_name AS "displayName", e.role, t.name AS team
      FROM employees e LEFT JOIN teams t ON t.id = e.team_id WHERE e.active ORDER BY e.role, e.display_name`);
    return r.rows;
  }

  @Public()
  @Post('auth/dev/login')
  @HttpCode(204)
  async devLogin(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    if (!this.env.DEV_AUTH) throw new NotFoundException();
    const { employeeId } = parseBody(z.object({ employeeId: z.string().min(1) }), body);
    const r = await this.db.execute(sql`SELECT id FROM employees WHERE id = ${employeeId} AND active`);
    if (!r.rows.length) throw new NotFoundException();
    const s = await this.sessions.create(employeeId);
    this.setSession(res, s.token, s.expiresAt);
  }

  // ---------- GitHub OAuth sign-in ----------

  @Public()
  @Get('auth/github')
  githubStart(@Res() res: Response) {
    if (!this.env.GITHUB_OAUTH_CLIENT_ID) throw new NotFoundException('GitHub sign-in is not configured');
    const state = randomBytes(16).toString('hex');
    res.cookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60_000, path: '/' });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.env.GITHUB_OAUTH_CLIENT_ID);
    url.searchParams.set('scope', 'read:user user:email read:org');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  }

  @Public()
  @Get('auth/github/callback')
  async githubCallback(@Query('code') code: string, @Query('state') state: string, @Req() req: Request, @Res() res: Response) {
    const expected = parseCookies(req.headers.cookie)[OAUTH_STATE_COOKIE];
    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
    if (!code || !state || state !== expected) throw new BadRequestException('Invalid OAuth state');

    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: this.env.GITHUB_OAUTH_CLIENT_SECRET,
        code,
      }),
    });
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    if (!access_token) throw new BadRequestException('GitHub did not return a token');
    const gh = (path: string) =>
      fetch(`https://api.github.com${path}`, {
        headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'live-workforce' },
      });

    const ghUser = (await (await gh('/user')).json()) as { id: number; login: string; name: string | null; avatar_url: string };

    // Only members of the company GitHub organization may sign in.
    if (this.env.GITHUB_ORG) {
      const m = await gh(`/user/memberships/orgs/${encodeURIComponent(this.env.GITHUB_ORG)}`);
      const membership = m.ok ? ((await m.json()) as { state: string }) : null;
      if (membership?.state !== 'active') throw new ForbiddenException(`You must be a member of ${this.env.GITHUB_ORG}`);
    }

    const githubId = String(ghUser.id);
    const linked = await this.db.execute<{ employee_id: string | null }>(
      sql`SELECT employee_id FROM external_identities WHERE source = 'GITHUB' AND external_id = ${githubId}`,
    );
    let employeeId = linked.rows[0]?.employee_id ?? null;
    if (!employeeId) {
      const admins = this.env.BOOTSTRAP_ADMIN_LOGINS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const role = admins.includes(ghUser.login.toLowerCase()) ? 'ADMIN' : 'MEMBER';
      const created = await this.db.execute<{ id: string }>(sql`
        INSERT INTO employees (id, display_name, avatar_url, role)
        VALUES (gen_random_uuid()::text, ${ghUser.name || ghUser.login}, ${ghUser.avatar_url}, ${role}::role) RETURNING id`);
      employeeId = created.rows[0].id;
      await this.identities.linkGithub(githubId, employeeId, 'OAUTH', ghUser.login, ghUser.avatar_url);
    }
    const s = await this.sessions.create(employeeId);
    this.setSession(res, s.token, s.expiresAt);
    res.redirect(`${this.env.WEB_ORIGIN}/office?source=github`);
  }
}
