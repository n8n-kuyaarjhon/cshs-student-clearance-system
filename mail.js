'use strict';

/**
 * Mail delivery with no third-party packages.
 *
 * - If SMTP_HOST is set, mail is sent through that SMTP server using a small
 *   hand-written SMTP client (STARTTLS + AUTH LOGIN supported).
 * - If it is not set, mail is kept in the `outbox` table and printed to the
 *   console, so the whole flow still works on a laptop with no mail account.
 *
 * Every message is recorded in `outbox` either way (audit trail).
 */

const net = require('node:net');
const tls = require('node:tls');

class SmtpError extends Error {}

class SmtpConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    this.closed = false;
    this.error = null;
    this.onData = (chunk) => this.feed(chunk);
    this.onError = (err) => this.fail(err);
    this.onClose = () => this.fail(new SmtpError('Connection closed'));
    socket.setEncoding('utf8');
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  feed(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.lines.push(line);
    }
  }

  fail(err) {
    if (this.closed) return;
    this.closed = true;
    this.error = err;
    while (this.waiters.length) this.waiters.shift().reject(err);
  }

  readLine(timeoutMs = 20000) {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.error) return Promise.reject(this.error);
    if (this.closed) return Promise.reject(new SmtpError('Connection closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(new SmtpError('SMTP timeout'));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  async expect(codes, step) {
    const line = await this.readLine();
    const code = Number(line.slice(0, 3));
    if (!codes.includes(code)) throw new SmtpError(`${step}: ${line}`);
    return line;
  }

  write(line) {
    this.socket.write(line + '\r\n');
  }

  async command(line, codes, step) {
    this.write(line);
    return this.expect(codes, step || line);
  }

  async upgrade() {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('error', this.onError);
    this.socket.removeListener('close', this.onClose);
    const secure = tls.connect({ socket: this.socket, servername: this.socket.servername || undefined });
    await new Promise((resolve, reject) => {
      secure.once('secureConnect', resolve);
      secure.once('error', reject);
    });
    this.socket = secure;
    this.buffer = '';
    this.closed = false;
    this.error = null;
    secure.setEncoding('utf8');
    secure.on('data', this.onData);
    secure.on('error', this.onError);
    secure.on('close', this.onClose);
  }

  async quit() {
    try { await this.command('QUIT', [221], 'QUIT'); } catch { /* best effort */ }
    this.socket.end();
  }
}

function encodeHeader(value) {
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

async function sendSmtp(smtp, { from, to, subject, text }) {
  const secure = smtp.secure || smtp.port === 465;
  const socket = secure
    ? tls.connect({ host: smtp.host, port: smtp.port, servername: smtp.host })
    : net.connect({ host: smtp.host, port: smtp.port });
  const conn = new SmtpConnection(socket);
  socket.setTimeout(20000, () => conn.fail(new SmtpError('SMTP timeout')));

  try {
    if (secure) {
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
    }
    await conn.expect([220], 'greeting');
    let ehlo = await conn.command(`EHLO ${smtp.host}`, [250], 'EHLO');

    if (!secure && smtp.starttls !== false) {
      conn.write('STARTTLS');
      await conn.expect([220], 'STARTTLS');
      await conn.upgrade();
      ehlo = await conn.command(`EHLO ${smtp.host}`, [250], 'EHLO after STARTTLS');
    }

    if (smtp.user && smtp.pass) {
      const line = await conn.command('AUTH LOGIN', [334], 'AUTH LOGIN');
      void line;
      await conn.command(Buffer.from(smtp.user).toString('base64'), [334], 'AUTH user');
      await conn.command(Buffer.from(smtp.pass).toString('base64'), [235], 'AUTH password');
    }

    await conn.command(`MAIL FROM:<${from}>`, [250], 'MAIL FROM');
    await conn.command(`RCPT TO:<${to}>`, [250, 251], 'RCPT TO');
    await conn.command('DATA', [354], 'DATA');

    const body = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    const message = [
      `From: ${encodeHeader(from)}`,
      `To: ${to}`,
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
    ].join('\r\n');
    conn.write(`${message}\r\n.`);
    await conn.expect([250], 'message body');
    await conn.quit();
  } catch (err) {
    try { socket.destroy(); } catch { /* ignore */ }
    throw err;
  }
}

function createMailer(repo, options = {}) {
  const smtp = options.smtp && options.smtp.host ? options.smtp : null;
  const from = options.from || 'no-reply@cshs.local';
  const log = options.log || console;

  return {
    mode: smtp ? 'smtp' : 'outbox',
    async send({ to, subject, text }) {
      if (!to) throw new Error('Missing recipient');

      if (!smtp) {
        const id = repo.outbox.create({ to, subject, body: text, status: 'logged' });
        log.log(`[mail:outbox] #${id} to=${to} subject="${subject}"`);
        log.log(text.split('\n').map((l) => '  | ' + l).join('\n'));
        return { id, status: 'logged' };
      }

      const id = repo.outbox.create({ to, subject, body: text, status: 'queued' });
      try {
        await sendSmtp(smtp, { from: options.fromAddress || from, to, subject, text });
        repo.outbox.markSent(id);
        return { id, status: 'sent' };
      } catch (err) {
        repo.outbox.markFailed(id, err.message);
        log.error(`[mail:error] #${id} to=${to}: ${err.message}`);
        return { id, status: 'failed', error: err.message };
      }
    },
  };
}

module.exports = { createMailer, sendSmtp, SmtpError };
