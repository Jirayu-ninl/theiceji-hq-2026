import type { Metadata, Viewport } from 'next'
import { Anuphan, Red_Hat_Mono, Red_Hat_Text } from 'next/font/google'
import type { ReactNode } from 'react'
import { BOOT_SCRIPT } from '@/lib/prefs'
import './globals.css'

// Bridge type: Red Hat Text for words, Red Hat Mono for
// readouts, Anuphan for Thai. Exposed as variables the tokens name.
const text = Red_Hat_Text({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-rh-text',
  display: 'swap',
})
const mono = Red_Hat_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-rh-mono',
  display: 'swap',
})
const thai = Anuphan({
  subsets: ['thai', 'latin'],
  weight: ['400', '500', '600'],
  variable: '--font-anuphan',
  display: 'swap',
})

const NAME = 'TheIceJi HQ'
const DESCRIPTION =
  'Personal command center — projects, modules, notes and tools.'

export const metadata: Metadata = {
  title: NAME,
  description: DESCRIPTION,
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'HQ' },
  icons: {
    icon: '/icon.svg',
    apple: { url: '/apple-touch-icon.png', sizes: '180x180' },
  },
  // The link preview: the images are app/opengraph-image.png
  // and app/twitter-image.png, which Next adds on its own.
  openGraph: {
    title: NAME,
    description: DESCRIPTION,
    siteName: NAME,
    type: 'website',
  },
  twitter: { card: 'summary_large_image', title: NAME },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'dark light',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang='en'
      className={`${text.variable} ${mono.variable} ${thai.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Theme and rail from the browser's prefs, before first paint (lib/prefs.ts). */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed string from this repo */}
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
