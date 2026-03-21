import bcrypt from 'bcryptjs';
import { SignJWT } from 'jose';
import { NextResponse } from 'next/server';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync('admin', 10);
const SESSION_SECRET = process.env.SESSION_SECRET || 'default_dev_secret_override_me';

const secretKey = new TextEncoder().encode(SESSION_SECRET);

export async function POST(request: Request) {
  try {
    const { username, password } = await request.json();

    if (username !== ADMIN_USERNAME) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const isMatch = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);

    if (!isMatch) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    // Create JWT session
    const token = await new SignJWT({ username })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('24h')
      .setIssuedAt()
      .sign(secretKey);

    const response = NextResponse.json({ success: true });

    // Set HttpOnly cookie
    response.cookies.set('kn_admin_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24, // 24 hours
      path: '/',
    });

    return response;
  } catch (e) {
    console.error('Auth error:', e);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
