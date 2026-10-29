import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { once } from 'node:events';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface SmtpConfig {
  host: string; port: number; security: 'tls' | 'starttls' | 'none';
  user?: string; password?: string; from: string;
}
export interface Mail { to: string; subject: string; text: string; attachment: { name: string; type: string; data: Buffer } }

const wrap = (base64: string) => base64.replace(/.{1,76}/g, line => `${line}\r\n`);
const encodeWord = (value: string) => /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
const asciiName = (name: string) => name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

export function message(config: SmtpConfig, mail: Mail) {
  const boundary = `tabularium-${randomUUID()}`;
  const domain = config.from.split('@')[1] ?? 'localhost';
  const { name, type, data } = mail.attachment;
  return [
    `From: ${config.from}`, `To: ${mail.to}`, `Subject: ${encodeWord(mail.subject)}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${randomUUID()}@${domain}>`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    wrap(Buffer.from(mail.text).toString('base64')) +
    `--${boundary}`, `Content-Type: ${type}; name="${asciiName(name)}"`, 'Content-Transfer-Encoding: base64',
    // RFC 2231 keeps the UTF-8 file name; the plain parameter is for clients that ignore it.
    `Content-Disposition: attachment; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`, '',
    wrap(data.toString('base64')) + `--${boundary}--`, '',
  ].join('\r\n');
}

/** A minimal SMTP client over node:net and node:tls, enough to deliver one message with one attachment. */
class Session {
  private socket!: Socket;
  private pending = '';
  private waiting: { resolve: (reply: { code: number; text: string }) => void; reject: (error: Error) => void }[] = [];
  private failure?: Error;

  attach(socket: Socket) {
    this.socket = socket;
    socket.setTimeout(60_000, () => socket.destroy(new Error('SMTP connection timed out')));
    socket.on('data', (chunk: Buffer) => { this.pending += chunk.toString('latin1'); this.drain(); });
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('SMTP connection closed')));
  }
  detach() {
    for (const event of ['data', 'error', 'close', 'timeout']) this.socket.removeAllListeners(event);
    this.socket.setTimeout(0);
    return this.socket;
  }
  private fail(error: Error) {
    this.failure ??= error;
    for (const waiter of this.waiting.splice(0)) waiter.reject(this.failure);
  }
  private drain() {
    while (this.waiting.length) {
      const match = this.pending.match(/^(?:\d{3}-[^\r\n]*\r\n)*(\d{3})(?: [^\r\n]*)?\r\n/);
      if (!match) return;
      this.pending = this.pending.slice(match[0].length);
      this.waiting.shift()!.resolve({ code: Number(match[1]), text: match[0].trim() });
    }
  }
  reply(expected: number[], step: string) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<{ code: number; text: string }>((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.drain();
    }).then(reply => {
      if (!expected.includes(reply.code)) throw new Error(`SMTP ${step}: ${reply.text}`);
      return reply;
    });
  }
  async command(line: string, expected: number[], step = line.split(' ')[0]) {
    this.socket.write(`${line}\r\n`);
    return this.reply(expected, step);
  }
}

async function connected(socket: Socket, event: string) {
  await Promise.race([once(socket, event), once(socket, 'error').then(([error]) => { throw error; })]);
  return socket;
}

export async function sendMail(config: SmtpConfig, mail: Mail) {
  const session = new Session();
  const socket = config.security === 'tls'
    ? await connected(tlsConnect({ host: config.host, port: config.port, servername: config.host }), 'secureConnect')
    : await connected(netConnect({ host: config.host, port: config.port }), 'connect');
  session.attach(socket);
  try {
    await session.reply([220], 'greeting');
    await session.command(`EHLO ${hostname()}`, [250]);
    if (config.security === 'starttls') {
      await session.command('STARTTLS', [220]);
      const upgraded = await connected(tlsConnect({ socket: session.detach(), servername: config.host }), 'secureConnect');
      session.attach(upgraded);
      await session.command(`EHLO ${hostname()}`, [250]);
    }
    if (config.user) {
      const credentials = Buffer.from(`\0${config.user}\0${config.password ?? ''}`).toString('base64');
      await session.command(`AUTH PLAIN ${credentials}`, [235], 'AUTH');
    }
    await session.command(`MAIL FROM:<${config.from}>`, [250], 'MAIL FROM');
    await session.command(`RCPT TO:<${mail.to}>`, [250, 251], 'RCPT TO');
    await session.command('DATA', [354]);
    // Base64 and header lines never start with a dot, so no dot-stuffing is needed.
    await session.command(`${message(config, mail)}.`, [250], 'message');
    // The message was accepted with 250 above; a failing QUIT does not change the delivery.
    await session.command('QUIT', [221]).catch(() => undefined);
  } finally {
    socket.destroy();
  }
}
