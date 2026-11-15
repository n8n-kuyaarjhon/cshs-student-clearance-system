'use strict';

/**
 * Minimal multipart/form-data parser (no dependencies).
 * Good enough for small uploads (a few MB) which is all this app accepts.
 */

function getBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  return match ? (match[1] || match[2]).trim() : null;
}

function parseHeaders(raw) {
  const headers = {};
  for (const line of raw.split('\r\n')) {
    if (!line) continue;
    const i = line.indexOf(':');
    if (i === -1) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

function dispositionValue(disposition, key) {
  const re = new RegExp(`${key}="([^"]*)"`, 'i');
  const m = re.exec(disposition || '');
  return m ? m[1] : null;
}

/** @returns {{fields: Record<string,string>, files: Array<{field:string,filename:string,mime:string,data:Buffer}>}} */
function parseMultipart(buffer, contentType) {
  const boundary = getBoundary(contentType);
  if (!boundary) throw Object.assign(new Error('Missing multipart boundary'), { status: 400 });

  const fields = {};
  const files = [];
  const delimiter = Buffer.from(`--${boundary}`);
  const endDelimiter = Buffer.from(`--${boundary}--`);

  let position = buffer.indexOf(delimiter);
  if (position === -1) throw Object.assign(new Error('Malformed multipart body'), { status: 400 });

  while (position !== -1) {
    let start = position + delimiter.length;
    if (buffer.slice(start, start + 2).toString() === '--') break; // closing delimiter
    if (buffer.slice(start, start + 2).toString() === '\r\n') start += 2;

    const next = buffer.indexOf(delimiter, start);
    if (next === -1) break;

    let part = buffer.slice(start, next);
    if (part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = parseHeaders(part.slice(0, headerEnd).toString('utf8'));
      const data = part.slice(headerEnd + 4);
      const disposition = headers['content-disposition'] || '';
      const name = dispositionValue(disposition, 'name');
      const filename = dispositionValue(disposition, 'filename');

      if (name) {
        if (filename !== null) {
          if (filename !== '') {
            files.push({
              field: name,
              filename,
              mime: headers['content-type'] || 'application/octet-stream',
              data,
            });
          }
        } else {
          fields[name] = data.toString('utf8');
        }
      }
    }

    if (buffer.slice(next, next + endDelimiter.length).equals(endDelimiter)) break;
    position = next;
  }

  return { fields, files };
}

module.exports = { parseMultipart, getBoundary };
