import { jwtVerify } from 'jose';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

const SESSION_SECRET = process.env.SESSION_SECRET || 'default_dev_secret_override_me';
const secretKey = new TextEncoder().encode(SESSION_SECRET);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public routes that don't need auth
  if (pathname.startsWith('/login') || pathname.startsWith('/api/auth')) {
    return NextResponse.next();
  }

  const sessionCookie = request.cookies.get('kn_admin_session');

  if (!sessionCookie) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  try {
    // Verify the JWT token
    await jwtVerify(sessionCookie.value, secretKey);

    return NextResponse.next();
  } catch (_error) {
    // Invalid or expired token
    return NextResponse.redirect(new URL('/login', request.url));
  }
}
