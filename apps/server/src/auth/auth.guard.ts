import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { type AuthUser, SessionService } from './session.service';

const PUBLIC = 'wf:public';
const ROLES = 'wf:roles';

/** Route needs no session (webhooks, sign-in). */
export const Public = () => SetMetadata(PUBLIC, true);
/** Route requires one of these roles. */
export const Roles = (...roles: AuthUser['role'][]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return (ctx.switchToHttp().getRequest() as Request & { user: AuthUser }).user;
});

/**
 * Global guard: every route is authenticated unless marked @Public().
 * State-changing requests must carry the X-Workforce-Client header, which a cross-site form or
 * image cannot send without a CORS preflight; that blocks CSRF on cookie-authenticated routes.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = await this.sessions.userFromCookieHeader(req.headers.cookie);
    if (!user) throw new UnauthorizedException();
    if (req.method !== 'GET' && req.headers['x-workforce-client'] !== 'web') {
      throw new ForbiddenException('Missing client header');
    }
    req.user = user;

    const roles = this.reflector.getAllAndOverride<AuthUser['role'][]>(ROLES, targets);
    if (roles && !roles.includes(user.role)) throw new ForbiddenException();
    return true;
  }
}

/** Individual metrics: yourself; your own team's members if you are a lead; anyone if you are an admin. */
export function canViewPerson(user: AuthUser, target: { id: string; teamId: string | null }): boolean {
  if (user.id === target.id || user.role === 'ADMIN') return true;
  return user.role === 'LEAD' && !!user.teamId && user.teamId === target.teamId;
}
