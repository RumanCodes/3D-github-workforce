import path from 'node:path';
import { fileURLToPath } from 'node:url';
const API_URL = process.env.API_URL ?? 'http://localhost:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  transpilePackages: ['@workforce/contracts'],
  // REST calls go through the web origin, so the session cookie is first-party.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
  },
};

export default nextConfig;
