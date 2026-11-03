import { createSign } from 'node:crypto';
import { Interval } from '@nestjs/schedule';
import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Db, type Env, InjectDb, InjectEnv } from '../infra/infra.module';

@Injectable()
export class GithubAppClient {
 @Interval(300000)
 async reconcile() {
  if (!this.env.GITHUB_APP_ID || this.env.ROLE === 'api') return;
  try { await this.sync(); } catch (error) { new Logger('GithubApp').warn(String(error)); }
 }
 private tokens = new Map<string, { token: string; expires: number }>();
 constructor(@InjectDb() private readonly db: Db, @InjectEnv() private readonly env: Env) {}
 private jwt() {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now()/1000);
  const data = `${enc({alg:'RS256',typ:'JWT'})}.${enc({iat:now-60,exp:now+540,iss:this.env.GITHUB_APP_ID})}`;
  const sign = createSign('RSA-SHA256'); sign.update(data);
  return `${data}.${sign.sign(this.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g,'\n'),'base64url')}`;
 }
 async request(path: string, token: string, method: 'GET' | 'POST' = 'GET') {
  assertGithubReadOnlyRequest(path, method);
  const res = await fetch(`https://api.github.com${path}`, { method, headers: { Authorization: `Bearer ${token}`, Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28' }, signal: AbortSignal.timeout(30000) });
  if(!res.ok) throw new Error(`GitHub request failed (${res.status})`);
  return res.json() as Promise<any>;
 }
 async token(id: string) {
  const cached = this.tokens.get(id); if(cached && cached.expires > Date.now()+60000) return cached.token;
  const data = await this.request(`/app/installations/${id}/access_tokens`,this.jwt(),'POST');
  this.tokens.set(id,{token:data.token,expires:Date.parse(data.expires_at)}); return data.token as string;
 }
 async forRepository(repo: string) {
  if(!this.env.GITHUB_APP_ID) return this.env.GITHUB_TOKEN;
  const row=(await this.db.execute<any>(sql`SELECT i.id FROM github_installations i JOIN repositories r ON split_part(r.full_name,'/',1)=i.login WHERE r.full_name=${repo} AND r.connected AND i.enabled`)).rows[0];
  if(!row) throw new Error('Repository is not connected to an active installation');
  return this.token(String(row.id));
 }
 async sync() {
  if(!this.env.GITHUB_APP_ID || !this.env.GITHUB_ORG) throw new Error('Configure GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and GITHUB_ORG');
  const installation = await this.request(`/orgs/${encodeURIComponent(this.env.GITHUB_ORG)}/installation`,this.jwt());
  if(installation.suspended_at) throw new Error('GitHub installation is suspended');
  const token = await this.token(String(installation.id));
  const repos: any[]=[];
  for(let page=1;;page++) { const data=await this.request(`/installation/repositories?per_page=100&page=${page}`,token); repos.push(...data.repositories); if(data.repositories.length<100) break; }
  const members: any[]=[];
  const teams: any[]=[];
  const memberships = new Map<string,string>();
  for(let page=1;;page++) { const data=await this.request(`/orgs/${encodeURIComponent(this.env.GITHUB_ORG)}/members?per_page=100&page=${page}`,token); members.push(...data); if(data.length<100) break; }
  for(let page=1;;page++) { const data=await this.request(`/orgs/${encodeURIComponent(this.env.GITHUB_ORG)}/teams?per_page=100&page=${page}`,token); teams.push(...data); if(data.length<100) break; }
  for(const team of teams.sort((a,b)=>a.slug.localeCompare(b.slug))) for(let page=1;;page++) {
    const data=await this.request(`/orgs/${encodeURIComponent(this.env.GITHUB_ORG)}/teams/${encodeURIComponent(team.slug)}/members?per_page=100&page=${page}`,token);
    for(const member of data) if(!memberships.has(String(member.id))) memberships.set(String(member.id), team.name);
    if(data.length<100) break;
  }
  await this.db.transaction(async tx=>{
   await tx.execute(sql`INSERT INTO github_installations(id,login,enabled,synced_at) VALUES(${installation.id},${this.env.GITHUB_ORG},true,now()) ON CONFLICT(id) DO UPDATE SET enabled=true,synced_at=now()`);
   await tx.execute(sql`UPDATE repositories SET connected=false WHERE lower(split_part(full_name,'/',1))=lower(${this.env.GITHUB_ORG})`);
   for (const team of teams) await tx.execute(sql`INSERT INTO teams(id,name,department) VALUES(gen_random_uuid()::text,${team.name},'Development') ON CONFLICT(name) DO NOTHING`);
   for (const member of members.filter(m=>m.type!=='Bot')) {
     const identity=(await tx.execute<any>(sql`SELECT employee_id FROM external_identities WHERE source='GITHUB' AND external_id=${String(member.id)}`)).rows[0];
     let employeeId=identity?.employee_id;
     if(!employeeId) {
       const local=(await tx.execute<any>(sql`SELECT e.id FROM employees e WHERE lower(e.display_name)=lower(${member.login}) AND NOT EXISTS(SELECT 1 FROM external_identities i WHERE i.employee_id=e.id) ORDER BY e.created_at LIMIT 1`)).rows[0];
       employeeId=local?.id;
       if(!employeeId) employeeId=(await tx.execute<any>(sql`INSERT INTO employees(id,display_name,avatar_url,role) VALUES(gen_random_uuid()::text,${member.login},${member.avatar_url},${this.env.BOOTSTRAP_ADMIN_LOGINS.toLowerCase().split(',').map(s=>s.trim()).includes(member.login.toLowerCase())?'ADMIN':'MEMBER'}::role) RETURNING id`)).rows[0].id;
       await tx.execute(sql`INSERT INTO external_identities(id,source,external_id,handle,avatar_url,employee_id,verified_by) VALUES(gen_random_uuid()::text,'GITHUB',${String(member.id)},${member.login},${member.avatar_url},${employeeId},'GITHUB_APP') ON CONFLICT(source,external_id) DO UPDATE SET employee_id=excluded.employee_id,handle=excluded.handle`);
     }
     const teamName=memberships.get(String(member.id));
     if(teamName) await tx.execute(sql`UPDATE employees SET team_id=(SELECT id FROM teams WHERE name=${teamName}) WHERE id=${employeeId} AND team_id IS NULL`);
   }
   for(const repo of repos) await tx.execute(sql`INSERT INTO repositories(id,github_id,full_name,default_branch,private,connected) VALUES(gen_random_uuid()::text,${repo.id},${repo.full_name},${repo.default_branch},${repo.private},true) ON CONFLICT(github_id) DO UPDATE SET full_name=excluded.full_name,connected=true`);
   // Each newly connected repository gets a product board; local grouping can combine them later.
   for(const repo of repos) {
     const row=(await tx.execute<any>(sql`SELECT product_id FROM repositories WHERE github_id=${repo.id}`)).rows[0];
     if(!row.product_id) {
       const product=(await tx.execute<any>(sql`INSERT INTO products(id,name) VALUES(gen_random_uuid()::text,${repo.name ?? repo.full_name.split('/')[1]}) ON CONFLICT(name) DO UPDATE SET name=excluded.name RETURNING id`)).rows[0];
       await tx.execute(sql`UPDATE repositories SET product_id=${product.id} WHERE github_id=${repo.id}`);
     }
   }
  });
  return { repositories:repos.length, syncedAt:new Date().toISOString() };
 }
}

/** POST is permitted only to mint an installation authentication token, never to change repository data. */
export function assertGithubReadOnlyRequest(path: string, method: string) {
 if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) throw new Error('Invalid GitHub API path');
 if (method === 'GET') return;
 if (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) return;
 throw new Error('Workforce is read-only: GitHub content writes are disabled');
}
