import type { NextConfig } from 'next';

const apiOrigin = validatedApiOrigin(
  process.env['NEXT_PUBLIC_SHIPYARD_API_URL'] ?? 'http://127.0.0.1:3001',
);

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@shipyard402/public-api-client'],
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: `default-src 'self'; connect-src 'self' ${apiOrigin}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
};

export default nextConfig;

function validatedApiOrigin(value: string): string {
  const url = new URL(value);
  const local = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (url.protocol !== 'https:' && !local) throw new Error('NEXT_PUBLIC_SHIPYARD_API_URL must use HTTPS outside local development');
  return url.origin;
}
