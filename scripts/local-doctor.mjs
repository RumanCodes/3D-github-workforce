import fs from 'node:fs';
import net from 'node:net';
const file = new URL('../apps/server/.env', import.meta.url);
const env = { ...process.env };
if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && env[m[1]] === undefined) env[m[1]] = m[2];
}
let failed = false;
for (const [name, value, port] of [['PostgreSQL', env.DATABASE_URL, 5432], ['Redis', env.REDIS_URL, 6379]]) {
  if (!value) { console.log(`${name}: configuration missing`); failed = true; continue; }
  try {
    const url = new URL(value);
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: url.hostname, port: Number(url.port || port) });
      socket.setTimeout(2500);
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
      socket.once('error', reject);
    });
    console.log(`${name}: port reachable (credentials and migrations still need verification)`);
  } catch (error) { console.log(`${name}: unavailable (${error.code ?? error.message})`); failed = true; }
}
console.log(`Organization: ${env.GITHUB_ORG || 'not configured'}`);
console.log(`Administrator: ${env.BOOTSTRAP_ADMIN_LOGINS || 'not configured'}`);
console.log(`GitHub App credentials: ${env.GITHUB_APP_ID && (env.GITHUB_APP_PRIVATE_KEY || (env.GITHUB_APP_PRIVATE_KEY_PATH && fs.existsSync(env.GITHUB_APP_PRIVATE_KEY_PATH))) ? 'configured' : 'missing'}`);
console.log(`GitHub sign-in: ${env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET ? 'configured' : 'not configured; local development sign-in only'}`);
console.log(`Contribution polling: ${env.GITHUB_POLL_ENABLED === 'true' ? 'enabled' : 'disabled'}`);
process.exitCode = failed ? 1 : 0;
