/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['better-sqlite3', 'sharp'],
  experimental: {
    serverActions: { bodySizeLimit: '20mb' }
  }
};
module.exports = nextConfig;
