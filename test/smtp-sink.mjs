// A local SMTP receiver for tests: plain connection, AUTH PLAIN, keeps every accepted message
// and, with `directory`, also writes it there as N.eml for another process to read.
import { createServer } from 'node:net';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function startSmtpSink({ user = 'sink', password = 'sink-password', directory } = {}) {
  const sink = { messages: [], rejectRecipients: false, port: 0, user, password };
  const server = createServer(socket => {
    let buffer = '', data = null, envelope = {};
    socket.write('220 sink ready\r\n');
    socket.on('data', chunk => {
      buffer += chunk.toString('latin1');
      while (true) {
        if (data !== null) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          sink.messages.push({ ...envelope, raw: Buffer.from(buffer.slice(0, end + 2), 'latin1') });
          if (directory) writeFileSync(join(directory, `${sink.messages.length}.eml`), sink.messages.at(-1).raw);
          buffer = buffer.slice(end + 5); data = null; envelope = {};
          socket.write('250 queued\r\n');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') socket.write('250-sink\r\n250 AUTH PLAIN\r\n');
        else if (verb === 'AUTH') {
          const [, , encoded] = line.split(' ');
          const [, name, secret] = Buffer.from(encoded, 'base64').toString().split('\0');
          socket.write(name === user && secret === password ? '235 ok\r\n' : '535 authentication failed\r\n');
        } else if (verb === 'MAIL') { envelope.from = line.slice(line.indexOf('<') + 1, -1); socket.write('250 ok\r\n'); }
        else if (verb === 'RCPT') {
          if (sink.rejectRecipients) { socket.write('550 mailbox unavailable\r\n'); continue; }
          envelope.to = line.slice(line.indexOf('<') + 1, -1); socket.write('250 ok\r\n');
        } else if (verb === 'DATA') { data = ''; socket.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') { socket.end('221 bye\r\n'); }
        else socket.write('502 not implemented\r\n');
      }
    });
    socket.on('error', () => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  sink.port = server.address().port;
  sink.close = () => new Promise(resolve => server.close(resolve));
  return sink;
}

/** Splits a multipart message and returns its headers and the decoded attachment. */
export function parseMessage(raw) {
  const text = raw.toString('latin1');
  const [head, ...rest] = text.split('\r\n\r\n');
  const header = name => head.match(new RegExp(`^${name}: (.*)$`, 'mi'))?.[1];
  const boundary = header('Content-Type').match(/boundary="([^"]+)"/)[1];
  const parts = rest.join('\r\n\r\n').split(`--${boundary}`).slice(1, -1);
  const attachment = parts.find(part => /Content-Disposition: attachment/i.test(part));
  const [partHead, partBody] = attachment.split('\r\n\r\n');
  const encodedName = partHead.match(/filename\*=UTF-8''([^\s;]+)/)[1];
  const subject = header('Subject');
  const decodedSubject = subject.startsWith('=?UTF-8?B?') ? Buffer.from(subject.slice(10, -2), 'base64').toString() : subject;
  return {
    from: header('From'), to: header('To'), subject: decodedSubject,
    fileName: decodeURIComponent(encodedName), type: partHead.match(/Content-Type: ([^;\r\n]+)/)[1],
    data: Buffer.from(partBody.replace(/\s+/g, ''), 'base64'),
  };
}
