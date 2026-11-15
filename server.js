'use strict';

/**
 * Student Clearance Document Request System — server.
 *
 * Run with:  node server.js
 * No `npm install`: only Node's built-in modules are used.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDatabase, ROLES } = require('./db.js');
const { createMailer } = require('./mail.js');
const { parseMultipart } = require('./multipart.js');

const DOCS = {
  form137_sf10: 'Form 137 / SF10',
  good_moral: 'Good Moral Certificate',
  clearance: 'School Clearance',
  report_card: 'Report Card / Transcript',
};
const PURPOSE = { employment: 'For Employment', university: 'For University', military: 'For Military', others: 'Others' };
const ID_TYPES = [
  'Philippine Passport', 'Driver’s License', 'UMID', 'PhilSys National ID (PhilID / ePhilID)', 'PRC ID',
  'Postal ID', 'Voter’s ID', 'SSS ID', 'GSIS ID', 'PhilHealth ID', 'TIN ID', 'Senior Citizen ID', 'PWD ID', 'OFW ID (iDOLE)',
];
const PROOF_LABEL = {
  university: 'Proof that the university requested your documents (request letter or admission requirement)',
  military: 'Proof that the head of the military office or unit requested your documents (letter or memorandum)',
  others: 'Proof of the request (optional)',
};

const MAX_JSON = 200 * 1024;
const MAX_UPLOAD = 15 * 1024 * 1024;
const MAX_FILE = 8 * 1024 * 1024;
const SESSION_HOURS = 12;
const OTP_MINUTES = 5;
const EMAIL_TOKEN_MINUTES = 30;
const TRACK_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// In demo mode every code is 123456 so the system can be tried on one laptop.
const DEMO_CODE = '123456';

const nowIso = () => new Date().toISOString();
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const addMinutes = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (message, status = 400) => new HttpError(status, message);

function normPhone(value) {
  const digits = String(value || '').replace(/\D/g, '').replace(/^63/, '').replace(/^0/, '');
  return /^9\d{9}$/.test(digits) ? '+63' + digits : null;
}
const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
const normTracking = (value) => {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 12 && raw.startsWith('CSHS') ? `CSHS-${raw.slice(4, 8)}-${raw.slice(8)}` : String(value || '').trim().toUpperCase();
};
const maskLrn = (lrn) => (lrn ? '••••••••' + String(lrn).slice(-4) : '');

function configFromEnv(overrides = {}) {
  const root = path.resolve(overrides.root || __dirname);
  const dataDir = path.resolve(overrides.dataDir || process.env.DATA_DIR || path.join(root, 'data'));
  const smtpHost = overrides.smtpHost !== undefined ? overrides.smtpHost : process.env.SMTP_HOST;
  const smtp = smtpHost
    ? {
        host: smtpHost,
        port: Number(overrides.smtpPort || process.env.SMTP_PORT || 587),
        secure: String(overrides.smtpSecure ?? process.env.SMTP_SECURE ?? '') === '1',
        user: overrides.smtpUser !== undefined ? overrides.smtpUser : process.env.SMTP_USER,
        pass: overrides.smtpPass !== undefined ? overrides.smtpPass : process.env.SMTP_PASS,
      }
    : null;

  return {
    root,
    dataDir,
    dbPath: path.resolve(overrides.dbPath || process.env.DB_PATH || path.join(dataDir, 'app.db')),
    uploadDir: path.resolve(overrides.uploadDir || process.env.UPLOAD_DIR || path.join(dataDir, 'uploads')),
    publicDir: path.resolve(overrides.publicDir || path.join(root, 'public')),
    port: Number(overrides.port ?? process.env.PORT ?? 3000),
    host: overrides.host || process.env.HOST || '127.0.0.1',
    demoMode: overrides.demoMode !== undefined
      ? Boolean(overrides.demoMode)
      : (process.env.DEMO_MODE !== undefined ? process.env.DEMO_MODE === '1' : !smtp),
    smtp,
    mailFrom: overrides.mailFrom || process.env.MAIL_FROM || 'no-reply@cshs.local',
    smsWebhook: overrides.smsWebhook !== undefined ? overrides.smsWebhook : (process.env.SMS_WEBHOOK_URL || null),
    registrar: {
      name: process.env.REGISTRAR_NAME || 'Registrar',
      phone: process.env.REGISTRAR_PHONE || '09170000002',
      email: process.env.REGISTRAR_EMAIL || 'registrar@cshs.edu.ph',
    },
    log: overrides.log || console,
  };
}

function createApp(overrides = {}) {
  const config = configFromEnv(overrides);
  const log = config.log;
  const repo = openDatabase(config.dbPath);
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const mailer = createMailer(repo, { smtp: config.smtp, from: config.mailFrom, fromAddress: config.mailFrom, log });

  // First run: create the bootstrap Registrar account.
  if (repo.staff.count() === 0) {
    const phone = normPhone(config.registrar.phone) || '+639170000002';
    repo.staff.create({ name: config.registrar.name, role: 'registrar', phone, email: config.registrar.email });
    log.log(`[setup] Created the first Registrar account: ${phone} / ${config.registrar.email}`);
  }

  function secret() {
    let value = repo.meta.get('secret');
    if (!value) {
      value = randomToken(32);
      repo.meta.set('secret', value);
    }
    return value;
  }

  /**
   * The registrar's student records are private. A name search therefore
   * returns a short-lived signed token instead of the full LRN.
   */
  function studentToken(lrn) {
    const payload = `${lrn}.${Date.now() + 30 * 60 * 1000}`;
    const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
    return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sig}`;
  }

  function readStudentToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    let payload;
    try {
      payload = Buffer.from(parts[0], 'base64url').toString('utf8');
    } catch {
      return null;
    }
    const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
    const given = Buffer.from(parts[1]);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
    const [lrn, expires] = payload.split('.');
    if (!/^\d{12}$/.test(lrn) || Number(expires) < Date.now()) return null;
    return lrn;
  }

  const otpThrottle = new Map();
  function throttleOtp(channel, target) {
    const key = `${channel}:${target}`;
    const stamps = (otpThrottle.get(key) || []).filter((t) => Date.now() - t < 10 * 60 * 1000);
    if (stamps.length >= 5) throw new HttpError(429, 'Too many codes requested. Try again in a few minutes.');
    stamps.push(Date.now());
    otpThrottle.set(key, stamps);
  }

  async function sendSms(phone, message) {
    if (config.smsWebhook) {
      try {
        const res = await fetch(config.smsWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, message }),
        });
        if (!res.ok) throw new Error(`SMS gateway returned ${res.status}`);
        return true;
      } catch (err) {
        log.error(`[sms:error] ${phone}: ${err.message}`);
        return false;
      }
    }
    log.log(`[sms:outbox] to=${phone}: ${message}`);
    return true;
  }

  async function notifyStudent(request, message) {
    const via = `Gmail (${request.email})`;
    repo.messages.create(request.id, message, via);
    const mail = await mailer.send({
      to: request.email,
      subject: `CSHS request ${request.tracking} — update`,
      text: `${message}\n\nTracking number: ${request.tracking}\nDocument: ${DOCS[request.doc]}\n\nCabiao Senior High School — Office of the Registrar`,
    });
    return { via, mail };
  }

  function notifyRoles(roles, message) {
    for (const staff of repo.staff.all()) {
      if (staff.active && roles.includes(staff.role)) repo.notifications.create(staff.id, message, 'In-app');
    }
  }

  function staffUser(staff) {
    return { id: staff.id, name: staff.name, role: staff.role, phone: staff.phone || null, email: staff.email || null, active: staff.active !== 0 };
  }

  function publicRequest(row) {
    return {
      id: row.id,
      tracking: row.tracking,
      doc: row.doc,
      name: row.name,
      section: row.section || '',
      purpose: row.purpose,
      purposeOther: row.purpose_other || '',
      employment: row.employment || '',
      university: row.university || '',
      status: row.status,
      reason: row.reason || '',
      release: row.release || '',
      lrnShown: maskLrn(row.lrn),
      claimant: row.claimant ? JSON.parse(row.claimant) : { type: 'self' },
      times: {
        received: row.created_at,
        approved: row.approved_at,
        rejected: row.rejected_at,
        ready: row.ready_at,
        claimed: row.claimed_at,
      },
      messages: repo.messages.forRequest(row.id).map((m) => ({ message: m.message, via: m.via, time: m.created_at })),
    };
  }

  function staffRequest(row) {
    const files = repo.files.forRequest(row.id);
    const byKind = (kind) => files.find((f) => f.kind === kind) || null;
    return {
      ...publicRequest(row),
      lrn: row.lrn || '',
      idType: row.id_type || '',
      phone: row.phone || '',
      email: row.email,
      authCheck: row.auth_check || '',
      idVerified: Boolean(row.id_verified),
      complete: Boolean(row.complete),
      claimedBy: row.claimed_by || '',
      files: {
        id: byKind('id') ? { id: byKind('id').id, mime: byKind('id').mime } : null,
        proof: byKind('proof') ? { id: byKind('proof').id, mime: byKind('proof').mime } : null,
        photo: byKind('photo') ? { id: byKind('photo').id, mime: byKind('photo').mime } : null,
      },
      messageLog: repo.messages.forRequest(row.id).map((m) => ({ message: m.message, via: m.via, time: m.created_at })),
    };
  }

  function issueSession(staff, req, res) {
    const token = randomToken(32);
    repo.sessions.create({
      tokenHash: sha256(token),
      staffId: staff.id,
      expiresAt: new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString(),
    });
    const secure = req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    const cookie = [
      `sid=${token}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${SESSION_HOURS * 3600}`,
      secure ? 'Secure' : '',
    ].filter(Boolean).join('; ');
    res.setHeader('Set-Cookie', cookie);
    return token;
  }

  function sessionStaff(req) {
    const cookie = req.headers.cookie || '';
    const match = /(?:^|;\s*)sid=([^;]+)/.exec(cookie);
    if (!match) return null;
    const row = repo.sessions.find(sha256(decodeURIComponent(match[1])));
    if (!row) return null;
    if (row.expires_at < nowIso()) {
      repo.sessions.delete(row.token_hash);
      return null;
    }
    if (row.active === 0) return null;
    return row;
  }

  function requireStaff(req, res, roles) {
    const staff = sessionStaff(req);
    if (!staff) {
      sendJson(res, 401, { error: 'Please log in.' });
      return null;
    }
    if (roles && !roles.includes(staff.role)) {
      sendJson(res, 403, { error: 'Your account cannot do this.' });
      return null;
    }
    return staff;
  }

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new HttpError(413, 'The upload is too large.'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function readJson(req) {
    const body = await readBody(req, MAX_JSON);
    if (!body.length) return {};
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      throw bad('Invalid JSON body');
    }
  }

  function generateTracking() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const pick = (n) => Array.from({ length: n }, () => TRACK_CHARS[crypto.randomInt(0, TRACK_CHARS.length)]).join('');
      const tracking = `CSHS-${pick(4)}-${pick(4)}`;
      if (!repo.requests.byTracking(tracking)) return tracking;
    }
    throw new Error('Could not generate a tracking number');
  }

  const fileExt = (filename) => {
    const ext = path.extname(String(filename || '')).toLowerCase();
    return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
  };

  async function saveUpload(requestId, kind, file) {
    if (!file) return null;
    const isImage = /^image\//.test(file.mime);
    const isPdf = file.mime === 'application/pdf';
    if (!isImage && !isPdf) throw bad('Upload a photo or a PDF only.', 415);
    if (file.data.length > MAX_FILE) throw new HttpError(413, 'Each file must be 8 MB or smaller.');
    if (kind === 'photo' && !isImage) throw bad('The photo of the person claiming must be an image.', 415);

    const dir = path.join(config.uploadDir, String(requestId));
    await fsp.mkdir(dir, { recursive: true });
    const name = `${kind}-${crypto.randomBytes(8).toString('hex')}${fileExt(file.filename)}`;
    await fsp.writeFile(path.join(dir, name), file.data);
    return repo.files.create({
      requestId,
      kind,
      filename: name,
      mime: file.mime,
      size: file.data.length,
    });
  }

  async function handleSendEmailCode(req, res) {
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (!isEmail(email)) throw bad('Enter a valid email address.');
    throttleOtp('email', email);
    const code = config.demoMode ? DEMO_CODE : newCode();
    repo.otp.issue({ channel: 'email', target: email, codeHash: sha256(code), expiresAt: addMinutes(OTP_MINUTES) });
    const mail = await mailer.send({
      to: email,
      subject: 'Your verification code — Cabiao Senior High School',
      text: `Your 6-digit code is ${code}.\n\nIt expires in ${OTP_MINUTES} minutes. If you did not ask for this, ignore this email.`,
    });
    sendJson(res, 200, { sent: mail.status !== 'failed', channel: 'email', expiresIn: OTP_MINUTES * 60, ...(config.demoMode ? { devCode: code } : {}) });
  }

  async function handleVerifyEmailCode(req, res) {
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim();
    const row = repo.otp.latest('email', email);
    if (!row) throw bad('Ask for a code first.');
    if (row.consumed) throw bad('That code was already used. Ask for a new one.');
    if (row.expires_at < nowIso()) throw bad('That code expired. Ask for a new one.');
    if (row.attempts >= 5) throw bad('Too many wrong codes. Ask for a new one.');
    if (sha256(code) !== row.code_hash) {
      repo.otp.bumpAttempts(row.id);
      throw bad('That code is not correct.');
    }
    repo.otp.consume(row.id);
    const token = randomToken(24);
    repo.emailVerifications.create({ email, tokenHash: sha256(token), expiresAt: addMinutes(EMAIL_TOKEN_MINUTES) });
    sendJson(res, 200, { emailToken: token, expiresIn: EMAIL_TOKEN_MINUTES * 60 });
  }

  async function handleOtpSend(req, res) {
    const body = await readJson(req);
    const phone = normPhone(body.phone);
    if (!phone) throw bad('Enter a valid mobile number, like 0917 123 4567.');
    throttleOtp('sms', phone);
    const staff = repo.staff.byPhone(phone);
    if (!staff) throw bad('This number is not on the staff list. Ask the Registrar to add you.', 404);
    if (staff.active === 0) throw bad('This account is turned off. Contact the Registrar.', 403);
    const code = config.demoMode ? DEMO_CODE : newCode();
    repo.otp.issue({ channel: 'sms', target: phone, codeHash: sha256(code), expiresAt: addMinutes(OTP_MINUTES) });
    await sendSms(phone, `Your Cabiao SHS staff code is ${code}. It expires in ${OTP_MINUTES} minutes.`);
    sendJson(res, 200, { sent: true, channel: 'sms', expiresIn: OTP_MINUTES * 60, ...(config.demoMode ? { devCode: code } : {}) });
  }

  async function handleOtpVerify(req, res) {
    const body = await readJson(req);
    const phone = normPhone(body.phone);
    const code = String(body.code || '').trim();
    if (!phone) throw bad('Enter a valid mobile number.');
    const row = repo.otp.latest('sms', phone);
    if (!row) throw bad('Ask for a code first.');
    if (row.consumed) throw bad('That code was already used. Ask for a new one.');
    if (row.expires_at < nowIso()) throw bad('That code expired. Ask for a new one.');
    if (row.attempts >= 5) throw bad('Too many wrong codes. Ask for a new one.');
    if (sha256(code) !== row.code_hash) {
      repo.otp.bumpAttempts(row.id);
      throw bad('That code is not correct.');
    }
    repo.otp.consume(row.id);
    const staff = repo.staff.byPhone(phone);
    if (!staff || staff.active === 0) throw bad('This account is not available.', 403);
    repo.staff.setChannel(staff.id, 'sms');
    issueSession(staff, req, res);
    sendJson(res, 200, { user: staffUser(staff) });
  }

  async function handleGoogleLogin(req, res) {
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (!isEmail(email)) throw bad('Enter a valid Gmail address.');
    if (!config.demoMode) throw bad('Google sign-in needs GOOGLE_CLIENT_ID and is disabled on this server.', 501);
    const staff = repo.staff.byEmail(email);
    if (!staff) throw bad('This email is not on the staff list. Ask the Registrar to add you.', 404);
    if (staff.active === 0) throw bad('This account is turned off. Contact the Registrar.', 403);
    repo.staff.setChannel(staff.id, 'email');
    issueSession(staff, req, res);
    sendJson(res, 200, { user: staffUser(staff) });
  }

  async function handleCreateRequest(req, res) {
    const raw = await readBody(req, MAX_UPLOAD);
    const { fields, files } = parseMultipart(raw, req.headers['content-type']);
    const pick = (name) => (files.find((f) => f.field === name) || null);
    const val = (name) => String(fields[name] || '').trim();

    const doc = val('doc');
    const email = val('email').toLowerCase();
    const emailToken = val('emailToken');
    const purpose = val('purpose');

    if (!DOCS[doc]) throw bad('Choose a document.');
    if (!isEmail(email)) throw bad('Enter your email address.');
    if (!PURPOSE[purpose]) throw bad('Choose the purpose of your request.');

    const verification = repo.emailVerifications.find(sha256(emailToken));
    if (!emailToken || !verification || verification.email !== email) throw bad('Verify your email first.');
    if (verification.consumed || verification.expires_at < nowIso()) throw bad('Your email verification expired. Verify it again.');

    const phoneRaw = val('phone');
    const phone = phoneRaw ? normPhone(phoneRaw) : '';
    if (phoneRaw && !phone) throw bad('Enter a valid mobile number, like 0917 123 4567, or leave it blank.');

    const lrn = readStudentToken(val('studentToken')) || val('lrn');
    if (lrn && !/^\d{12}$/.test(lrn)) throw bad('The LRN must be 12 digits.');

    let student = lrn ? repo.students.byLrn(lrn) : null;
    let name;
    let section = '';
    let complete = true;
    if (student) {
      name = [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(' ');
      section = student.last_grade_level ? `Grade ${student.last_grade_level} - ${student.section}` : (student.section || '');
    } else {
      const first = val('firstName');
      const last = val('lastName');
      if (!first || !last) throw bad('Enter your first name and last name.');
      name = [first, val('middleName'), last].filter(Boolean).join(' ');
      section = val('section');
      complete = false;
    }

    if (purpose === 'others' && !val('purposeOther')) throw bad('Please specify the purpose.');
    const employment = purpose === 'employment' ? val('employment') : '';
    if (purpose === 'employment' && !['local', 'abroad'].includes(employment)) throw bad('Choose whether the employment is local or abroad.');
    const idType = purpose === 'employment' ? val('idType') : '';
    if (purpose === 'employment' && !ID_TYPES.includes(idType)) throw bad('Choose the type of government ID.');
    const idFile = purpose === 'employment' ? pick('idFile') : null;
    if (purpose === 'employment' && !idFile) throw bad('Upload your government ID as evidence for employment.');
    const university = purpose === 'university' ? val('university') : '';
    if (purpose === 'university' && !university) throw bad('Enter the name of the university or school requesting your documents.');
    const proofFile = pick('proofFile');

    let claimant = { type: 'self' };
    let photoFile = null;
    if (val('claimer') === 'rep') {
      const repName = val('repName');
      const relationship = val('relationship');
      const repPhoneRaw = val('repPhone');
      const repPhone = repPhoneRaw ? normPhone(repPhoneRaw) : '';
      if (!repName || !relationship || !val('repIdType')) throw bad('Fill in the authorization letter: name, relationship and ID of the person claiming.');
      if (repPhoneRaw && !repPhone) throw bad('Enter a valid mobile number for the person claiming, or leave it blank.');
      if (!val('signedName')) throw bad('Type your full name as your signature on the letter.');
      if (val('auConfirm') !== '1') throw bad('Tick the box to confirm that you authorize this person.');
      photoFile = pick('photo');
      if (!photoFile) throw bad('Upload a clear photo of the person who will claim the document.');
      claimant = {
        type: 'rep',
        repName,
        relationship,
        repPhone,
        repIdType: val('repIdType'),
        reason: val('repReason'),
        signedName: val('signedName'),
        signedAt: nowIso(),
      };
    }

    if (purpose === 'military' && !proofFile) throw bad('Upload the proof of request from the military office or unit.');
    if (purpose === 'university' && !proofFile) throw bad('Upload the proof that the university requested your documents.');

    const tracking = generateTracking();
    const request = repo.requests.create({
      tracking, doc, name, lrn: student ? lrn : (lrn || null), section, phone, email, purpose,
      purpose_other: val('purposeOther'), employment, id_type: idType, university, claimant, complete,
    });

    const saved = [];
    if (idFile) saved.push(await saveUpload(request.id, 'id', idFile));
    if (proofFile) saved.push(await saveUpload(request.id, 'proof', proofFile));
    if (photoFile) saved.push(await saveUpload(request.id, 'photo', photoFile));

    repo.emailVerifications.consume(verification.id);

    const message = `Request received. Your tracking number is ${tracking}. Use it in Track my request.`;
    await notifyStudent(request, message);
    notifyRoles(['registrar', 'admin_assistant', 'principal'],
      `New request ${tracking}: ${DOCS[doc]} from ${name} (${PURPOSE[purpose]}).${claimant.type === 'rep' ? ` Will be claimed by ${claimant.repName} (${claimant.relationship}).` : ''} Check the uploaded documents.`);

    const fresh = repo.requests.byId(request.id);
    sendJson(res, 201, { request: publicRequest(fresh), tracking, files: saved.map((f) => ({ id: f.id, kind: f.kind })) });
  }

  function requireRequestRow(id) {
    const row = repo.requests.byId(id);
    if (!row) throw bad('Request not found.', 404);
    return row;
  }

  async function handleDecision(req, res, id) {
    const staff = requireStaff(req, res);
    if (!staff) return;
    const body = await readJson(req);
    const decision = String(body.decision || '');
    if (!['approved', 'rejected'].includes(decision)) throw bad('Unknown decision.');
    const row = requireRequestRow(id);
    if (row.status !== 'pending') throw bad('This request was already decided.', 409);

    if (decision === 'approved') {
      if (!row.id_verified) throw bad('Cannot approve: check the documents first.');
      const claimant = row.claimant ? JSON.parse(row.claimant) : { type: 'self' };
      if (claimant.type === 'rep' && row.auth_check !== 'correct') throw bad('Cannot approve: check the authorization letter first.');
    }
    const reason = String(body.reason || '').trim();
    if (decision === 'rejected' && !reason) throw bad('Give a reason so the student knows what to fix.');

    const updated = repo.requests.setDecision(row.id, decision, reason);
    const reasonText = reason.replace(/\.+$/, '');
    await notifyStudent(updated, decision === 'approved'
      ? `Request ${updated.tracking} is approved. The school is preparing your document. We will message you when it is ready for pick-up.`
      : `Request ${updated.tracking} was rejected: ${reasonText}. Fix the issue and submit a new request.`);
    sendJson(res, 200, { request: staffRequest(updated) });
  }

  function handleIdVerified(req, res, id) {
    const staff = requireStaff(req, res);
    if (!staff) return;
    const row = requireRequestRow(id);
    if (row.status !== 'pending') throw bad('This request was already decided.', 409);
    repo.requests.setIdVerified(row.id);
    sendJson(res, 200, { request: staffRequest(repo.requests.byId(row.id)) });
  }

  async function handleAuthCheck(req, res, id) {
    const staff = requireStaff(req, res);
    if (!staff) return;
    const body = await readJson(req);
    const status = String(body.status || '');
    if (!['correct', 'not_found'].includes(status)) throw bad('Unknown authorization status.');
    const row = requireRequestRow(id);
    if (row.status !== 'pending') throw bad('This request was already decided.', 409);
    const claimant = row.claimant ? JSON.parse(row.claimant) : { type: 'self' };
    if (claimant.type !== 'rep') throw bad('This request has no representative.');
    repo.requests.setAuthCheck(row.id, status);
    sendJson(res, 200, { request: staffRequest(repo.requests.byId(row.id)) });
  }

  async function handleRelease(req, res, id) {
    const staff = requireStaff(req, res, ['registrar', 'admin_assistant']);
    if (!staff) return;
    const body = await readJson(req);
    const status = String(body.status || '');
    const row = requireRequestRow(id);
    if (row.status !== 'approved') throw bad('Only approved requests can be released.', 409);

    if (status === 'ready_for_pickup' || status === 'ready') {
      if (row.release === 'claimed') throw bad('This document was already claimed.', 409);
      if (row.release === 'ready') throw bad('This document is already ready for pick-up.', 409);
      const updated = repo.requests.setRelease(row.id, 'ready', null);
      await notifyStudent(updated, `Request ${updated.tracking} is ready for pick-up at the Registrar’s Office. Bring your valid ID and your tracking number. If someone else will claim it, they must bring the signed authorization letter.`);
      return sendJson(res, 200, { request: staffRequest(updated) });
    }

    if (status === 'claimed') {
      if (row.release !== 'ready') throw bad('Mark it ready for pick-up first.', 409);
      const claimedBy = String(body.claimedBy || '').trim()
        || (row.claimant && JSON.parse(row.claimant).repName) || row.name;
      const updated = repo.requests.setRelease(row.id, 'claimed', claimedBy);
      await notifyStudent(updated, `Request ${updated.tracking}: your document was released. Thank you!`);
      return sendJson(res, 200, { request: staffRequest(updated) });
    }

    throw bad('Unknown release status.');
  }

  function handleTrack(res, trackingRaw) {
    const row = repo.requests.byTracking(normTracking(trackingRaw));
    if (!row) return sendJson(res, 404, { error: 'No request found for this tracking number.' });
    sendJson(res, 200, { request: publicRequest(row) });
  }

  function handleSearchStudents(res, url) {
    const q = url.searchParams;
    const matches = repo.students.search({
      first_name: q.get('first_name'),
      last_name: q.get('last_name'),
      middle_name: q.get('middle_name'),
      strand: q.get('strand'),
      year_graduated: q.get('year_graduated'),
    }).map((s) => ({
      first_name: s.first_name,
      middle_name: s.middle_name,
      last_name: s.last_name,
      strand: s.strand,
      last_grade_level: s.last_grade_level,
      section: s.section,
      year_graduated: s.year_graduated,
      lrn_last4: s.lrn.slice(-4),
      studentToken: studentToken(s.lrn),
    }));
    sendJson(res, 200, { matches });
  }

  function handleLookupStudent(res, lrn) {
    if (!/^\d{12}$/.test(String(lrn || ''))) throw bad('The LRN must be 12 digits.');
    const student = repo.students.byLrn(lrn);
    if (!student) return sendJson(res, 404, { error: 'Student record not found.' });
    sendJson(res, 200, {
      student: {
        first_name: student.first_name,
        middle_name: student.middle_name,
        last_name: student.last_name,
        strand: student.strand,
        last_grade_level: student.last_grade_level,
        section: student.section,
        year_graduated: student.year_graduated,
        lrn_last4: student.lrn.slice(-4),
        studentToken: studentToken(student.lrn),
        lrnShown: maskLrn(student.lrn),
      },
    });
  }

  async function handleAddStudent(req, res) {
    const staff = requireStaff(req, res, ['registrar', 'admin_assistant']);
    if (!staff) return;
    const body = await readJson(req);
    const lrn = String(body.lrn || '').trim();
    if (!/^\d{12}$/.test(lrn)) throw bad('The LRN must be 12 digits.');
    if (!String(body.first_name || '').trim() || !String(body.last_name || '').trim()) throw bad('First name and last name are required.');
    const student = repo.students.upsert({
      lrn,
      first_name: String(body.first_name).trim(),
      middle_name: String(body.middle_name || '').trim() || null,
      last_name: String(body.last_name).trim(),
      strand: String(body.strand || '').trim() || null,
      last_grade_level: body.last_grade_level || null,
      section: String(body.section || '').trim() || null,
      year_graduated: body.year_graduated || null,
    });
    sendJson(res, 201, { student });
  }

  function handleListRequests(res) {
    sendJson(res, 200, { requests: repo.requests.all().map(staffRequest) });
  }

  function handleNotifications(req, res, staff) {
    const items = repo.notifications.forStaff(staff.id)
      .map((n) => ({ id: n.id, message: n.message, via: n.via, read: Boolean(n.read), time: n.created_at }));
    sendJson(res, 200, { items, unread: repo.notifications.unread(staff.id) });
  }

  async function handleAddStaff(req, res) {
    const staff = requireStaff(req, res, ['registrar']);
    if (!staff) return;
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const role = String(body.role || '');
    const phoneRaw = String(body.phone || '').trim();
    const phone = phoneRaw ? normPhone(phoneRaw) : null;
    const email = String(body.email || '').trim().toLowerCase() || null;
    if (!name) throw bad('Enter the full name.');
    if (!phone && !email) throw bad('Enter a mobile number or an email so they can log in.');
    if (phoneRaw && !phone) throw bad('Enter a valid mobile number, like 0917 123 4567.');
    if (email && !isEmail(email)) throw bad('Enter a valid email address.');
    if (!ROLES.includes(role)) throw bad('Unknown role.');
    if (phone && repo.staff.byPhone(phone)) throw bad('This mobile number already has an account.', 409);
    if (email && repo.staff.byEmail(email)) throw bad('This email already has an account.', 409);
    const created = repo.staff.create({ name, role, phone, email });
    sendJson(res, 201, { user: staffUser(created) });
  }

  function handleListStaff(res) {
    sendJson(res, 200, { users: repo.staff.all().map(staffUser) });
  }

  async function handleToggleStaff(req, res, id) {
    const staff = requireStaff(req, res, ['registrar']);
    if (!staff) return;
    const body = await readJson(req);
    if (Number(id) === staff.id) throw bad('You cannot turn off your own account.');
    const target = repo.staff.byId(Number(id));
    if (!target) throw bad('Account not found.', 404);
    const updated = repo.staff.setActive(target.id, Boolean(body.active));
    sendJson(res, 200, { user: staffUser(updated) });
  }

  async function serveFile(req, res, id) {
    const staff = requireStaff(req, res);
    if (!staff) return;
    const file = repo.files.byId(id);
    if (!file) throw bad('File not found.', 404);
    const filePath = path.join(config.uploadDir, String(file.request_id), file.filename);
    let data;
    try {
      data = await fsp.readFile(filePath);
    } catch {
      throw bad('The file is missing on the server.', 410);
    }
    res.writeHead(200, {
      'Content-Type': file.mime,
      'Content-Length': data.length,
      'Content-Disposition': `inline; filename="${file.kind}${path.extname(file.filename)}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=60',
    });
    res.end(data);
  }

  function serveStatic(req, res, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (relative.includes('..') || relative.includes('\0')) return sendJson(res, 400, { error: 'Bad path' });
    const filePath = path.resolve(config.publicDir, relative);
    if (!filePath.startsWith(path.resolve(config.publicDir))) return sendJson(res, 403, { error: 'Forbidden' });
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        if (pathname === '/') return sendJson(res, 500, { error: 'public/index.html is missing.' });
        return sendJson(res, 404, { error: 'Not found' });
      }
      const ext = path.extname(filePath).toLowerCase();
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.json': 'application/json; charset=utf-8',
      };
      res.writeHead(200, {
        'Content-Type': types[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  const routes = [
    ['GET', /^\/api\/health$/, async (req, res) => sendJson(res, 200, {
      ok: true,
      service: 'cshs-document-request',
      mail: mailer.mode,
      demoMode: config.demoMode,
      time: nowIso(),
    })],
    ['GET', /^\/api\/me$/, async (req, res) => {
      const staff = sessionStaff(req);
      sendJson(res, 200, { user: staff ? staffUser(staff) : null });
    }],
    ['POST', /^\/api\/logout$/, async (req, res) => {
      const cookie = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
      if (cookie) repo.sessions.delete(sha256(decodeURIComponent(cookie[1])));
      res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      sendJson(res, 200, { ok: true });
    }],
    ['POST', /^\/api\/email\/send-code$/, handleSendEmailCode],
    ['POST', /^\/api\/email\/verify$/, handleVerifyEmailCode],
    ['POST', /^\/api\/auth\/otp\/send$/, handleOtpSend],
    ['POST', /^\/api\/auth\/otp\/verify$/, handleOtpVerify],
    ['POST', /^\/api\/auth\/google$/, handleGoogleLogin],
    ['GET', /^\/api\/students\/search$/, async (req, res) => handleSearchStudents(res, new URL(req.url, 'http://local'))],
    ['GET', /^\/api\/students\/lookup\/([^/]+)$/, async (req, res, m) => handleLookupStudent(res, decodeURIComponent(m[1]))],
    ['POST', /^\/api\/requests$/, handleCreateRequest],
    ['GET', /^\/api\/requests$/, async (req, res) => { if (!requireStaff(req, res)) return; handleListRequests(res); }],
    ['POST', /^\/api\/requests\/(\d+)\/decision$/, async (req, res, m) => handleDecision(req, res, Number(m[1]))],
    ['POST', /^\/api\/requests\/(\d+)\/id-verified$/, async (req, res, m) => handleIdVerified(req, res, Number(m[1]))],
    ['POST', /^\/api\/requests\/(\d+)\/authorization-check$/, async (req, res, m) => handleAuthCheck(req, res, Number(m[1]))],
    ['POST', /^\/api\/requests\/(\d+)\/release$/, async (req, res, m) => handleRelease(req, res, Number(m[1]))],
    ['GET', /^\/api\/track\/([^/]+)$/, async (req, res, m) => handleTrack(res, decodeURIComponent(m[1]))],
    ['GET', /^\/api\/files\/(\d+)$/, async (req, res, m) => serveFile(req, res, Number(m[1]))],
    ['GET', /^\/api\/notifications$/, async (req, res) => {
      const staff = requireStaff(req, res);
      if (staff) handleNotifications(req, res, staff);
    }],
    ['POST', /^\/api\/notifications\/read$/, async (req, res) => {
      const staff = requireStaff(req, res);
      if (!staff) return;
      repo.notifications.markAllRead(staff.id);
      sendJson(res, 200, { ok: true });
    }],
    ['GET', /^\/api\/admin\/users$/, async (req, res) => { if (!requireStaff(req, res, ['registrar'])) return; handleListStaff(res); }],
    ['POST', /^\/api\/admin\/users$/, handleAddStaff],
    ['PATCH', /^\/api\/admin\/users\/(\d+)$/, async (req, res, m) => handleToggleStaff(req, res, Number(m[1]))],
    ['POST', /^\/api\/admin\/students$/, handleAddStudent],
    ['GET', /^\/api\/dev\/outbox$/, async (req, res) => {
      if (!config.demoMode) return sendJson(res, 404, { error: 'Not found' });
      sendJson(res, 200, { messages: repo.outbox.list(50) });
    }],
  ];

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    try {
      if (pathname.startsWith('/api/')) {
        for (const [method, pattern, handler] of routes) {
          if (req.method !== method) continue;
          const match = pattern.exec(pathname);
          if (!match) continue;
          await handler(req, res, match);
          return;
        }
        return sendJson(res, 404, { error: 'Unknown API endpoint.' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
      return serveStatic(req, res, pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error('[error]', err);
      if (!res.headersSent) sendJson(res, status, { error: status >= 500 ? 'Something went wrong on the server.' : err.message });
      else res.end();
    }
  });

  function start() {
    return new Promise((resolve) => {
      server.listen(config.port, config.host, () => {
        const address = server.address();
        log.log('');
        log.log(`  Student Request System running at http://${config.host}:${address.port}`);
        log.log(`  Database: ${config.dbPath}`);
        log.log(`  Mail: ${mailer.mode === 'smtp' ? 'SMTP' : 'outbox (shown in this console)'}${config.demoMode ? ' · demo mode: codes are returned to the browser' : ''}`);
        log.log(`  Staff log in with ${repo.staff.all().find((u) => u.role === 'registrar')?.phone || '(no registrar yet)'}`);
        log.log('');
        resolve(address);
      });
    });
  }

  function close() {
    repo.sessions.purge();
    return new Promise((resolve) => server.close(() => { repo.close(); resolve(); }));
  }

  return { server, repo, mailer, config, start, close };
}

if (require.main === module) {
  const app = createApp();
  const shutdown = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  app.start();
}

module.exports = { createApp, configFromEnv, DOCS, PURPOSE, ID_TYPES, normTracking };
