import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['@prisma/client'],
  async headers() {
    return [
      {
        source: '/:path*',
        /*
         * Skip React Server Component payload requests.
         *
         * Next.js serves those as `text/x-component`, and Chromium's opaque
         * response blocking aborts a `nosniff` response whose MIME type it does
         * not recognise. The result is that client-side navigation silently
         * fails: the request returns 200 and is then discarded. These are
         * same-origin fetches issued by the framework itself, not documents, so
         * the document-level protections do not apply to them.
         */
        missing: [
          { type: 'query', key: '_rsc' },
          { type: 'header', key: 'RSC' },
        ],
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
