'use strict';

/**
 * End-to-end test against the real HTTP server and a real SQLite database.
 * Run with:  node test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('./server.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cshs-test-'));
const silent = { log() {}, error() {} };
const REGISTRAR_PHONE = '09170000002';

let app;
let base;
let cookie = '';
let staffUser = null;

async function startServer() {
  app = createApp({ port: 0, host: '127.0.0.1', dataDir, demoMode: true, log: silent });
  const address = await app.start();
  base = `http://127.0.0.1:${address.port}`;
}

async function request(pathName, { method = 'GET', body, useCookie = cookie, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (useCookie) opts.headers.Cookie = useCookie;
  const res = await fetch(base + pathName, opts);
  const text = await res.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, data, setCookie, headers: res.headers };
}

async function sendEmailCode(email) {
  const res = await request('/api/email/send-code', { method: 'POST', body: { email } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.devCode, '123456');
  return res.data.devCode;
}

async function verifyEmail(email) {
  const code = await sendEmailCode(email);
  const wrong = await request('/api/email/verify', { method: 'POST', body: { email, code: '000000' } });
  assert.equal(wrong.status, 400);
  const res = await request('/api/email/verify', { method: 'POST', body: { email, code } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.data.emailToken);
  return res.data.emailToken;
}

function pdfBlob() {
  return new Blob([Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF')], { type: 'application/pdf' });
}

function pngBlob() {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
  return new Blob([png], { type: 'image/png' });
}

test('Student Request System — full flow', async (t) => {
  await startServer();

  await t.test('health check and public endpoints', async () => {
    const health = await request('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);
    assert.equal(health.data.mail, 'outbox');

    const page = await request('/');
    assert.equal(page.status, 200);
  });

  await t.test('staff login with a one-time code', async () => {
    const unauthenticated = await request('/api/requests');
    assert.equal(unauthenticated.status, 401);

    const step1 = await request('/api/auth/otp/send', { method: 'POST', body: { phone: '09170000002' } });
    assert.equal(step1.status, 200);
    const code = step1.data.devCode;
    assert.equal(code, '123456');

    const wrong = await request('/api/auth/otp/verify', { method: 'POST', body: { phone: REGISTRAR_PHONE, code: '000000' } });
    assert.equal(wrong.status, 400);

    const step2 = await request('/api/auth/otp/verify', { method: 'POST', body: { phone: REGISTRAR_PHONE, code } });
    assert.equal(step2.status, 200, JSON.stringify(step2.data));
    assert.equal(step2.data.user.role, 'registrar');
    assert.equal(step2.setCookie.length, 1);
    cookie = step2.setCookie[0].split(';')[0];
    staffUser = step2.data.user;
    assert.match(cookie, /^sid=/);

    const me = await request('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.user.name, staffUser.name);
  });

  await t.test('registrar adds a learner record', async () => {
    const res = await request('/api/admin/students', {
      method: 'POST',
      body: {
        lrn: '123456789012',
        first_name: 'Maria',
        middle_name: 'Santos',
        last_name: 'Dela Cruz',
        strand: 'STEM',
        last_grade_level: 12,
        section: 'Rizal',
        year_graduated: 2024,
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.student.lrn, '123456789012');

    const updated = await request('/api/admin/students', {
      method: 'POST',
      body: { lrn: '123456789012', first_name: 'Maria', middle_name: 'Santos', last_name: 'Dela Cruz', strand: 'STEM', last_grade_level: 12, section: 'Rizal II', year_graduated: 2024 },
    });
    assert.equal(updated.status, 201);
    assert.equal(updated.data.student.section, 'Rizal II');
  });

  await t.test('name search never returns the full LRN', async () => {
    const res = await request('/api/students/search?first_name=Maria&last_name=Dela%20Cruz');
    assert.equal(res.status, 200);
    assert.equal(res.data.matches.length, 1);
    const match = res.data.matches[0];
    assert.equal(match.lrn_last4, '9012');
    assert.equal(match.lrn, undefined);
    assert.ok(match.studentToken);
  });

  await t.test('LRN lookup', async () => {
    const found = await request('/api/students/lookup/123456789012');
    assert.equal(found.status, 200);
    assert.equal(found.data.student.first_name, 'Maria');
    assert.equal(found.data.student.lrn, undefined);
    assert.ok(found.data.student.studentToken);

    assert.equal((await request('/api/students/lookup/1234')).status, 400);
    assert.equal((await request('/api/students/lookup/999999999999')).status, 404);
  });

  const studentToken = (await request('/api/students/lookup/123456789012')).data.student.studentToken;
  const email = 'maria.delacruz@gmail.com';
  const emailToken = await verifyEmail(email);
  let tracking = '';
  let requestId = 0;
  let proofFileId = 0;

  await t.test('email verification is required before submitting', async () => {
    const fd = new FormData();
    fd.append('doc', 'form137_sf10');
    fd.append('email', email);
    fd.append('purpose', 'university');
    fd.append('university', 'Sample University');
    fd.append('studentToken', studentToken);
    const res = await request('/api/requests', { method: 'POST', body: fd });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /verify your email/i);
  });

  await t.test('server rejects a request without the required proof', async () => {
    const fd = new FormData();
    fd.append('doc', 'form137_sf10');
    fd.append('email', email);
    fd.append('emailToken', emailToken);
    fd.append('purpose', 'university');
    fd.append('university', 'Sample University');
    fd.append('studentToken', studentToken);
    const res = await request('/api/requests', { method: 'POST', body: fd });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /proof/i);
  });

  await t.test('a student submits a request with a real upload', async () => {
    const fd = new FormData();
    fd.append('doc', 'form137_sf10');
    fd.append('email', email);
    fd.append('emailToken', emailToken);
    fd.append('phone', '0917 123 4567');
    fd.append('purpose', 'university');
    fd.append('university', 'Sample University');
    fd.append('studentToken', studentToken);
    fd.append('proofFile', pdfBlob(), 'request-letter.pdf');

    const res = await request('/api/requests', { method: 'POST', body: fd });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    tracking = res.data.request.tracking;
    requestId = res.data.request.id;
    assert.match(tracking, /^CSHS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(res.data.request.status, 'pending');
    assert.equal(res.data.request.name, 'Maria Santos Dela Cruz');
    assert.equal(res.data.request.lrnShown, '••••••••9012');
    assert.equal(res.data.request.claimant.type, 'self');

    const proof = res.data.files.find((f) => f.kind === 'proof');
    assert.ok(proof);
    proofFileId = proof.id;

    // The same email token cannot be replayed.
    const fd2 = new FormData();
    fd2.append('doc', 'clearance');
    fd2.append('email', email);
    fd2.append('emailToken', emailToken);
    fd2.append('purpose', 'others');
    fd2.append('purposeOther', 'Replay');
    fd2.append('studentToken', studentToken);
    const replay = await request('/api/requests', { method: 'POST', body: fd2 });
    assert.equal(replay.status, 400);
  });

  await t.test('the student can track the request without an account', async () => {
    const res = await request('/api/track/' + tracking);
    assert.equal(res.status, 200);
    assert.equal(res.data.request.status, 'pending');
    assert.equal(res.data.request.email, undefined);
    assert.equal(res.data.request.lrn, undefined);
    assert.equal((await request('/api/track/CSHS-AAAA-AAAA')).status, 404);
    assert.equal((await request('/api/track/not-a-number')).status, 404);
  });

  await t.test('the registrar sees the request and its file', async () => {
    const list = await request('/api/requests');
    assert.equal(list.status, 200);
    const row = list.data.requests.find((r) => r.id === requestId);
    assert.ok(row);
    assert.equal(row.email, email);
    assert.equal(row.lrn, '123456789012');
    assert.equal(row.files.proof.id, proofFileId);

    const file = await fetch(`${base}/api/files/${proofFileId}`, { headers: { Cookie: cookie } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    assert.ok((await file.text()).startsWith('%PDF'));

    const denied = await fetch(`${base}/api/files/${proofFileId}`);
    assert.equal(denied.status, 401);
  });

  await t.test('approval rules are enforced by the server', async () => {
    const tooEarly = await request(`/api/requests/${requestId}/decision`, { method: 'POST', body: { decision: 'approved' } });
    assert.equal(tooEarly.status, 400);
    assert.match(tooEarly.data.error, /check the documents/i);

    const verified = await request(`/api/requests/${requestId}/id-verified`, { method: 'POST', body: {} });
    assert.equal(verified.status, 200);
    assert.equal(verified.data.request.idVerified, true);

    const approved = await request(`/api/requests/${requestId}/decision`, { method: 'POST', body: { decision: 'approved' } });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal(approved.data.request.status, 'approved');
    assert.equal(approved.data.request.release, 'preparing');

    const twice = await request(`/api/requests/${requestId}/decision`, { method: 'POST', body: { decision: 'rejected', reason: 'x' } });
    assert.equal(twice.status, 409);
  });

  await t.test('each status change is emailed to the student', async () => {
    const outbox = await request('/api/dev/outbox');
    assert.equal(outbox.status, 200);
    const messages = outbox.data.messages.filter((m) => m.to_addr === email);
    assert.ok(messages.length >= 3, `expected at least 3 emails, got ${messages.length}`);
    assert.ok(messages.some((m) => m.body.includes(tracking) && /approved/i.test(m.body)));

    const tracked = await request('/api/track/' + tracking);
    assert.ok(tracked.data.request.messages.length >= 2);
    assert.ok(tracked.data.request.times.approved);
  });

  await t.test('pick-up release moves ready → claimed', async () => {
    const ready = await request(`/api/requests/${requestId}/release`, { method: 'POST', body: { status: 'ready_for_pickup' } });
    assert.equal(ready.status, 200, JSON.stringify(ready.data));
    assert.equal(ready.data.request.release, 'ready');

    const claimed = await request(`/api/requests/${requestId}/release`, { method: 'POST', body: { status: 'claimed', claimedBy: 'Maria Santos Dela Cruz' } });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.data.request.release, 'claimed');
    assert.equal(claimed.data.request.claimedBy, 'Maria Santos Dela Cruz');

    const tracked = await request('/api/track/' + tracking);
    assert.equal(tracked.data.request.release, 'claimed');
    assert.equal(tracked.data.request.status, 'approved');
    assert.ok(tracked.data.request.times.claimed);

    const again = await request(`/api/requests/${requestId}/release`, { method: 'POST', body: { status: 'claimed' } });
    assert.equal(again.status, 409);
  });

  await t.test('a representative request needs the authorization check', async () => {
    await request('/api/admin/students', {
      method: 'POST',
      body: { lrn: '123456789055', first_name: 'Maria', middle_name: 'Lopez', last_name: 'Dela Cruz', strand: 'ABM', last_grade_level: 12, section: 'Mabini', year_graduated: 2023 },
    });
    const repToken = (await request('/api/students/lookup/123456789055')).data.student.studentToken;
    const repEmail = 'juan.reyes@gmail.com';
    const token = await verifyEmail(repEmail);

    const fd = new FormData();
    fd.append('doc', 'good_moral');
    fd.append('email', repEmail);
    fd.append('emailToken', token);
    fd.append('purpose', 'employment');
    fd.append('employment', 'abroad');
    fd.append('idType', 'UMID');
    fd.append('studentToken', repToken);
    fd.append('claimer', 'rep');
    fd.append('repName', 'Pedro Dela Cruz');
    fd.append('relationship', 'Father');
    fd.append('repIdType', 'Driver’s License');
    fd.append('repPhone', '09171112222');
    fd.append('signedName', 'Maria Lopez Dela Cruz');
    fd.append('auConfirm', '1');
    fd.append('idFile', pngBlob(), 'umid.png');
    fd.append('photo', pngBlob(), 'face.png');

    const created = await request('/api/requests', { method: 'POST', body: fd });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.request.id;
    assert.equal(created.data.request.claimant.repName, 'Pedro Dela Cruz');

    const listed = await request('/api/requests');
    const stored = listed.data.requests.find((r) => r.id === id);
    assert.equal(stored.idType, 'UMID');

    await request(`/api/requests/${id}/id-verified`, { method: 'POST', body: {} });
    const blocked = await request(`/api/requests/${id}/decision`, { method: 'POST', body: { decision: 'approved' } });
    assert.equal(blocked.status, 400);
    assert.match(blocked.data.error, /authorization/i);

    const wrongAuth = await request(`/api/requests/${id}/authorization-check`, { method: 'POST', body: { status: 'not_found' } });
    assert.equal(wrongAuth.status, 200);
    assert.equal(wrongAuth.data.request.authCheck, 'not_found');
    const stillBlocked = await request(`/api/requests/${id}/decision`, { method: 'POST', body: { decision: 'approved' } });
    assert.equal(stillBlocked.status, 400);

    const goodAuth = await request(`/api/requests/${id}/authorization-check`, { method: 'POST', body: { status: 'correct' } });
    assert.equal(goodAuth.status, 200);
    const approved = await request(`/api/requests/${id}/decision`, { method: 'POST', body: { decision: 'approved' } });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
  });

  await t.test('requests typed by hand are flagged for checking', async () => {
    const manualEmail = 'manual.student@gmail.com';
    const token = await verifyEmail(manualEmail);
    const fd = new FormData();
    fd.append('doc', 'clearance');
    fd.append('email', manualEmail);
    fd.append('emailToken', token);
    fd.append('purpose', 'others');
    fd.append('purposeOther', 'Scholarship');
    fd.append('firstName', 'Ana');
    fd.append('lastName', 'Reyes');
    const created = await request('/api/requests', { method: 'POST', body: fd });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.request.name, 'Ana Reyes');

    const list = await request('/api/requests');
    const row = list.data.requests.find((r) => r.id === created.data.request.id);
    assert.equal(row.complete, false);
  });

  await t.test('role permissions are enforced', async () => {
    const created = await request('/api/admin/users', {
      method: 'POST',
      body: { name: 'Principal Cruz', role: 'principal', email: 'principal.cruz@gmail.com' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));

    const google = await request('/api/auth/google', { method: 'POST', body: { email: 'principal.cruz@gmail.com' } });
    assert.equal(google.status, 200);
    const principalCookie = google.setCookie[0].split(';')[0];

    const accounts = await request('/api/admin/users', { useCookie: principalCookie });
    assert.equal(accounts.status, 403);

    const review = await request('/api/requests', { useCookie: principalCookie });
    assert.equal(review.status, 200);

    const selfOff = await request(`/api/admin/users/${staffUser.id}`, { method: 'PATCH', body: { active: false } });
    assert.equal(selfOff.status, 400);

    const users = await request('/api/admin/users');
    assert.ok(users.data.users.length >= 2);
    assert.equal(users.data.users.find((u) => u.id === staffUser.id).active, true);
  });

  await t.test('data survives a server restart', async () => {
    await app.close();
    await startServer();

    const tracked = await request('/api/track/' + tracking);
    assert.equal(tracked.status, 200);
    assert.equal(tracked.data.request.release, 'claimed');

    const list = await request('/api/requests', { useCookie: cookie });
    assert.equal(list.status, 200);
    assert.ok(list.data.requests.some((r) => r.tracking === tracking));

    const students = await request('/api/students/lookup/123456789012');
    assert.equal(students.status, 200);
    assert.ok(students.data.student.studentToken);
  });
});

test('cleanup', async () => {
  try { await app.close(); } catch { /* already closed */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(dataDir), false);
});
