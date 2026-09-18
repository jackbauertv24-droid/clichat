// Small HTTP helpers shared by the two servers in this project.
//
// `serve` (src/server.mjs) is an OpenAI-compatible API meant to be called by
// other tools, so it answers with permissive CORS. The web view (src/webui.mjs)
// drives an agent that writes files, so it must NOT -- a wildcard there would
// let any page in any tab POST a task. CORS is therefore opt-in per response
// rather than baked into sendJson.

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export const cors = () => ({
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
});

export function sendError(res, status, message, type = 'invalid_request_error', headers = {}) {
  sendJson(res, status, { error: { message, type, code: status } }, headers);
}

export function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
