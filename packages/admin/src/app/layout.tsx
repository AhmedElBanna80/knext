import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'kn-next Observability Admin',
  description: 'Built-in observability, metrics, and load testing administration for kn-next.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-black text-white antialiased min-h-screen">{children}</body>
    </html>
  );
}
