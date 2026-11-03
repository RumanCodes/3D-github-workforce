import { describe,it,expect } from 'vitest';
import { deriveActivity } from '../src/presence/derive-activity';
describe('office source semantics',()=>{
 const now=new Date();
 it('does not animate even fresh imported activity',()=>expect(deriveActivity({verb:'pr.merged',provenance:'POLLED',occurredAt:now,data:{}},now)).toBeNull());
 it('labels verified recent contribution animations as inference',()=>expect(deriveActivity({verb:'review.submitted',provenance:'VERIFIED',occurredAt:now,data:{}},now)?.provenance).toBe('INFERRED'));
 it('does not animate expired contributions',()=>expect(deriveActivity({verb:'pr.merged',provenance:'VERIFIED',occurredAt:new Date(0),data:{}},now)).toBeNull());
});
