import { describe,it,expect } from 'vitest';
import { createDemo, demoMessages } from './demo';
import { officeSpatial, activityDestination } from './spatial';
import { useLive } from '../../lib/live';
describe('demo and live office model',()=>{
 it('creates 150 fictional employees with stable non-overlapping team seats',()=>{
  const d=createDemo(150,1000000), spatial=officeSpatial(d.agents,d.layout);
  expect(d.agents).toHaveLength(150);expect(spatial.zones).toHaveLength(6);
  expect(new Set([...spatial.positions.values()].map(p=>p.join(','))).size).toBe(150);
  expect(d.feed.every(e=>e.url===null&&e.repo?.startsWith('demo-company/'))).toBe(true);
  expect(officeSpatial([...d.agents].reverse(),d.layout).positions).toEqual(spatial.positions);
 });
 it('moves reviews to a shared station and returns quiet agents to their desk',()=>{
  const d=createDemo(),s=officeSpatial(d.agents,d.layout),desk=s.positions.get(d.agents[0].employeeId)!;
  expect(activityDestination('REVIEWING',desk,s,0)).not.toEqual(activityDestination('NONE',desk,s,0));
  expect(activityDestination('NONE',desk,s,0)).toEqual([desk[0],0,desk[2]+1]);
 });
 it('deduplicates live events and suppresses replay celebrations',()=>{
  const d=createDemo();useLive.getState().seed(d.feed,d.agents);useLive.setState({lastSeq:0});
  const messages=demoMessages(d.agents[0],4,0);
  useLive.getState().apply([...messages].reverse());expect(useLive.getState().freshIds.size).toBe(1);
  useLive.getState().apply(messages);expect(useLive.getState().freshIds.size).toBe(0);
  useLive.getState().apply(demoMessages(d.agents[1],5,2),false);expect(useLive.getState().freshIds.size).toBe(0);
  expect(useLive.getState().lastSeq).toBe(4);
 });
});
