import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Every HQ page is dynamic, and Next keeps none of them by default, so
  // going back to a view you left a moment ago re-read everything. Keep a
  // visited page for 30 s; any server action still refreshes the lot
  // (`runAction` revalidates the layout), so your own changes show at once.
  experimental: { staleTimes: { dynamic: 30 } },
  // PDFKit reads its own font metrics from disk at runtime; bundling it
  // loses them. Quotes' fonts ship with the package and are traced in.
  serverExternalPackages: ['pdfkit'],
  outputFileTracingIncludes: {
    '/**': ['../../packages/hq-quotes/fonts/*.ttf'],
  },
  transpilePackages: [
    '@theiceji/hq-agents',
    '@theiceji/hq-assets',
    '@theiceji/hq-auth',
    '@theiceji/hq-board',
    '@theiceji/hq-calendar',
    '@theiceji/hq-core',
    '@theiceji/hq-db',
    '@theiceji/hq-experiments',
    '@theiceji/hq-market',
    '@theiceji/hq-ops',
    '@theiceji/hq-prompts',
    '@theiceji/hq-publish',
    '@theiceji/hq-push',
    '@theiceji/hq-quotes',
    '@theiceji/hq-readings',
    '@theiceji/hq-storage',
    '@theiceji/hq-story',
    '@theiceji/net-guard',
  ],
  // Connections moved into Settings; old links, bookmarks and the MCP server's
  // documentation URL still land on it. The Creator and Merchant workspaces
  // became projects: their old URLs go to /projects (308).
  async redirects() {
    return [
      {
        source: '/connections',
        destination: '/settings/connections',
        permanent: true,
      },
      { source: '/creator', destination: '/projects', permanent: true },
      { source: '/creator/:path*', destination: '/projects', permanent: true },
      { source: '/merchant', destination: '/projects', permanent: true },
      { source: '/merchant/:path*', destination: '/projects', permanent: true },
    ]
  },
  // The OAuth consent screen must never be framed — a clickjacked "Allow"
  // would hand an app access to HQ.
  async headers() {
    return [
      {
        source: '/oauth/authorize',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
    ]
  },
}

export default nextConfig
