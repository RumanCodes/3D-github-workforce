import 'reflect-metadata';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { OfficeController } from '../src/api/office.controller';
import { testDb, resetDb, ingest } from './helpers';
import { prEvent } from '../scripts/lib/github-payloads';
import { OutboxRelay } from '../src/worker/outbox.relay';
import { GithubAppClient } from '../src/github/app-client';
const {db,pool}=testDb();
afterAll(()=>pool.end());beforeEach(()=>resetDb(db));
describe('office database integration with fictional data',()=>{
 it('keeps seats stable across snapshots and returns product projection totals',async()=>{
  await db.execute(sql`INSERT INTO employees(id,display_name,role) VALUES('demo-ari','Ari River','MEMBER')`);
  await db.execute(sql`INSERT INTO external_identities(id,source,external_id,handle,employee_id) VALUES('identity','GITHUB','1','ari','demo-ari')`);
  await ingest(db,prEvent('opened',{repo:{id:12,full_name:'fictional/product'},number:1,title:'Example',author:{id:1,login:'ari'},createdAt:new Date(),updatedAt:new Date(),headSha:'abc123'},{id:1,login:'ari'}));
  const office=new OfficeController(db);
  const before=await office.layout();
  await office.product({name:'Example product',repositories:[before.repositories[0].id]});
  const after=await office.layout();expect(after.desks).toEqual(before.desks);
  expect(after.products[0].openPrs).toBe(1);expect(after.products[0].awaitingReview).toBe(1);
  const snapshot=await office.snapshot();expect(snapshot.agents).toHaveLength(1);expect(snapshot.feed).toHaveLength(1);expect(snapshot.cursor).toBeGreaterThan(0);
 });
 it('imports organization members, teams and products using only mocked GitHub reads',async()=>{
  const app=new GithubAppClient(db,{GITHUB_APP_ID:'1',GITHUB_ORG:'fictional',BOOTSTRAP_ADMIN_LOGINS:'ari'} as any);
  (app as any).jwt=()=> 'fake-auth';
  (app as any).token=async()=> 'fake-installation-token';
  const requested:string[]=[];
  app.request=async(path:string)=>{requested.push(path);if(path.endsWith('/installation'))return{id:100};if(path.includes('/installation/repositories'))return{repositories:[{id:12,name:'product',full_name:'fictional/product',default_branch:'main',private:true}]};if(path.includes('/teams?'))return[{name:'Engineering',slug:'engineering'}];if(path.includes('/members?'))return[{id:1,login:'ari',avatar_url:null,type:'User'}];throw new Error(path);};
  await app.sync();await app.sync();
  const employees=(await db.execute<any>(sql`SELECT display_name,role,team_id FROM employees`)).rows;expect(employees).toHaveLength(1);expect(employees[0].role).toBe('ADMIN');expect(employees[0].team_id).toBeTruthy();
  expect((await new OfficeController(db).layout()).products).toHaveLength(1);
  expect(requested.every(p=>p.startsWith('/'))).toBe(true);
 });
 it('retains outbox messages after a Redis publish failure and retries safely',async()=>{
  await db.execute(sql`INSERT INTO outbox(topic,payload) VALUES('org','{"type":"event"}'::jsonb)`);
  let failed=true;
  const pipeline={publish:()=>pipeline,exec:async()=>[[failed?new Error('fake outage'):null,1]]};
  const relay=new OutboxRelay(db,{pipeline:()=>pipeline} as any,{} as any);
  await relay.flush();
  expect((await db.execute<any>(sql`SELECT published_at FROM outbox`)).rows[0].published_at).toBeNull();
  failed=false;await relay.flush();
  expect((await db.execute<any>(sql`SELECT published_at FROM outbox`)).rows[0].published_at).not.toBeNull();
 });

});
