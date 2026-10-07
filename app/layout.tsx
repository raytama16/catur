import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Catur Online — Main Berdua dari 2 Device',
  description:
    'Catur online 2 pemain dari device berbeda. Dibangun dengan Next.js, siap di-hosting di Vercel, tanpa database sama sekali.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0f1420',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
