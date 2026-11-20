import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/[[...path]]/route';
import { resetMemoryBackend } from '@/services/rate-limit/memoryBackend';
import { signup } from '@/services/SignupService';
import { SESSION_COOKIE } from '@/lib/session';

process.env.AUTH_MODE = 'production';
process.env.AUTH_SESSION_SECRET = 'isolated-signup-budget-test-session-secret';
process.env.RESEND_API_KEY = '';
process.env.RATE_LIMIT_BACKEND = 'memory';
process.env.NEXT_PUBLIC_APP_ORIGIN = 'http://localhost:3215';

async function main() {
  resetMemoryBackend();
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    // Six different addresses from one IP must consume ONE aggregate 5/hour
    // signup budget, as well as their independent IP/email buckets.
    const request = new NextRequest('http://localhost:3215/api/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3215', 'x-forwarded-for': '192.0.2.49' },
      body: JSON.stringify({ email: `budget-${i}@example.invalid`, password: 'DisposableBudget123!', name: 'Budget test' }),
    });
    const response = await POST(request, { params: Promise.resolve({ path: ['auth','signup'] }) });
    statuses.push(response.status);
  }
  assert.deepEqual(statuses, [200,200,200,200,200,429], 'Rotating email must not reset the shared IP signup budget');
  resetMemoryBackend();
  const owner = await signup({ email: 'resend-budget@example.invalid', password: 'DisposableBudget123!', name: 'Resend test' });
  const resend = await POST(new NextRequest('http://localhost:3215/api/auth/resend-verification', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3215', cookie: `${SESSION_COOKIE}=${owner.sessionToken}` }, body: '{}',
  }), { params: Promise.resolve({ path: ['auth','resend-verification'] }) });
  assert.equal(resend.status, 400, 'A mock email provider must not claim successful verification delivery');
  const body = await resend.json();
  assert.equal(body.error.code, 'EMAIL_NOT_CONFIGURED');
  assert.equal(body.ok, false);
  assert.equal(body.token, undefined, 'A verification token must never be returned to the browser');
  const hostileLogin = await POST(new NextRequest('http://localhost:3215/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'text/plain', origin: 'https://untrusted.example.invalid' },
    body: JSON.stringify({ email: owner.user.email, password: 'DisposableBudget123!' }),
  }), { params: Promise.resolve({ path: ['auth','login'] }) });
  assert.equal(hostileLogin.status, 403, 'Explicit cross-origin login must not issue a session');
  assert.equal(hostileLogin.headers.get('set-cookie'), null);
  console.log('signup-ip-budget-and-email-status: 3 passed, 0 failed');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
