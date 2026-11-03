import { describe, it, expect } from 'vitest';
import { assertGithubReadOnlyRequest } from '../src/github/app-client';
describe('GitHub is read-only',()=>{
 it('allows repository reads and installation authentication only',()=>{
  expect(()=>assertGithubReadOnlyRequest('/repos/example-org/example/pulls','GET')).not.toThrow();
  expect(()=>assertGithubReadOnlyRequest('/app/installations/123/access_tokens','POST')).not.toThrow();
 });
 it.each(['POST','PATCH','PUT','DELETE'])('rejects %s content changes',method=>{
  expect(()=>assertGithubReadOnlyRequest('/repos/example-org/example/issues',method)).toThrow('read-only');
 });
 it('rejects alternate origins and token-path suffixes',()=>{
  expect(()=>assertGithubReadOnlyRequest('//evil.test','GET')).toThrow();
  expect(()=>assertGithubReadOnlyRequest('/app/installations/123/access_tokens/extra','POST')).toThrow();
 });
});
