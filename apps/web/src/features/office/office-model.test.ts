import { describe, it, expect } from 'vitest';
import { deskPosition } from './office-model';
describe('3D seating',()=>{
 it('gives 150 employees unique spaced seats',()=>{
  const points=Array.from({length:150},(_,i)=>deskPosition(i+1));
  expect(new Set(points.map(p=>p.join(','))).size).toBe(150);
  for(let i=0;i<points.length;i++) for(let j=i+1;j<points.length;j++) expect(Math.hypot(points[i][0]-points[j][0],points[i][2]-points[j][2])).toBeGreaterThan(3);
 });
 it('keeps a seat fixed when the roster changes',()=>{expect(deskPosition(42)[0]).toBeCloseTo(-11.9); expect(deskPosition(42)[2]).toBeCloseTo(5.2);});
});
