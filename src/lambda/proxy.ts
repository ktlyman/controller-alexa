/**
 * Minimal AWS Lambda function that proxies Alexa directives to your
 * local machine over HTTPS.
 *
 * Deploy this single file to Lambda. It reads FORWARD_URL from the
 * Lambda environment variables and POSTs every directive there.
 *
 * Your local server (src/server.ts) exposes POST /directive which
 * this proxy hits. Use a tunnel (ngrok, Cloudflare Tunnel, Tailscale
 * Funnel) to expose your local server to the internet.
 *
 * Environment variables (set in Lambda console or via setup script):
 *   FORWARD_URL — e.g. https://abc123.ngrok.io/directive
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';

export async function handler(event: unknown): Promise<unknown> {
  const forwardUrl = process.env.FORWARD_URL;
  if (!forwardUrl) {
    return {
      event: {
        header: {
          namespace: 'Alexa',
          name: 'ErrorResponse',
          messageId: 'error',
          payloadVersion: '3',
        },
        payload: {
          type: 'INTERNAL_ERROR',
          message: 'FORWARD_URL not configured in Lambda environment',
        },
      },
    };
  }

  try {
    const response = await forward(forwardUrl, JSON.stringify(event));
    return JSON.parse(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      event: {
        header: {
          namespace: 'Alexa',
          name: 'ErrorResponse',
          messageId: 'error',
          payloadVersion: '3',
        },
        payload: {
          type: 'INTERNAL_ERROR',
          message: `Proxy forward failed: ${message}`,
        },
      },
    };
  }
}

function forward(urlStr: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 7000, // Alexa times out at 8s, leave a buffer
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(data);
          } else {
            reject(new Error(`Forward returned ${res.statusCode}: ${data}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Forward request timed out'));
    });
    req.write(body);
    req.end();
  });
}
