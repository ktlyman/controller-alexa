/**
 * Local HTTP server that runs on your machine and processes Alexa
 * Smart Home directives forwarded from the AWS Lambda proxy.
 *
 * Usage:
 *   npx ts-node src/server.ts          # development
 *   node dist/server.js                # after build
 *
 * The Lambda proxy (deployed to AWS) forwards every Alexa directive
 * to this server at POST /directive, and returns the response to Alexa.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { loadConfig } from './config';
import { AlexaAgentTool } from './agent';
import type { AlexaMessage } from './types/alexa';

const config = loadConfig();
const tool = new AlexaAgentTool({ config, userId: 'local-user' });

// Import the Lambda handler factory so we can run the same logic locally
import { createHandler } from './lambda';

const handler = createHandler({
  config,
  auth: tool.getAuth(),
  deviceRegistry: tool.getDeviceRegistry(),
  deviceController: tool.getDeviceController(),
  eventLogger: tool.getEventLogger(),
});

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const publicDir = path.resolve(__dirname, '..', 'public');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStaticFile(reqUrl: string, res: http.ServerResponse): boolean {
  let urlPath = reqUrl.split('?')[0]; // strip query string
  if (urlPath === '/') urlPath = '/index.html';

  // Security: prevent directory traversal
  const filePath = path.resolve(publicDir, '.' + urlPath);
  if (!filePath.startsWith(publicDir)) {
    return false;
  }

  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return false;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Auto-poll timer
// ---------------------------------------------------------------------------

let autoPollTimer: ReturnType<typeof setInterval> | null = null;
let autoPollIntervalMs = config.autoPollIntervalMinutes * 60 * 1000;

function startAutoPoll(intervalMs?: number): void {
  stopAutoPoll();
  const ms = intervalMs ?? autoPollIntervalMs;
  if (ms <= 0) return;
  autoPollIntervalMs = ms;
  autoPollTimer = setInterval(async () => {
    try {
      console.log(`  Auto-poll: polling all states...`);
      const result = await tool.execute({ type: 'poll_all_states' });
      if (result.success) {
        const d = result.data as { polledCount: number; errorCount: number };
        console.log(`  Auto-poll: ${d.polledCount} devices (${d.errorCount} unreachable)`);
        broadcastSSE('auto-poll', { polledCount: d.polledCount, errorCount: d.errorCount, timestamp: new Date().toISOString() });
      } else {
        console.log(`  Auto-poll: ${result.error}`);
      }
    } catch (err) {
      console.log(`  Auto-poll: failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }, ms);
}

function stopAutoPoll(): void {
  if (autoPollTimer) {
    clearInterval(autoPollTimer);
    autoPollTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Server-Sent Events (SSE) for real-time push events
// ---------------------------------------------------------------------------

const sseClients = new Set<http.ServerResponse>();

function broadcastSSE(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Subscribe to all events from the EventLogger and forward to SSE clients
tool.getEventLogger().subscribe((event) => {
  broadcastSSE('event', event);
});

// Periodic push-status heartbeat for SSE clients
setInterval(() => {
  if (sseClients.size === 0) return;
  const pushClient = tool.getPushClient();
  const status = pushClient
    ? {
        connected: pushClient.isConnected(),
        state: pushClient.getState(),
        connectionId: pushClient.getConnectionId(),
        lastEventTime: pushClient.getLastEventTime()
          ? new Date(pushClient.getLastEventTime()!).toISOString()
          : null,
        eventCount: pushClient.getEventCount(),
      }
    : { connected: false, state: 'disconnected', connectionId: null, lastEventTime: null, eventCount: 0 };
  broadcastSSE('push-status', status);
}, 5000);

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', storageBackend: config.storageBackend }));
    return;
  }

  // Cookie status (unofficial API auth)
  if (req.method === 'GET' && req.url === '/cookie-status') {
    const hasCookie = tool.getAlexaApiClient().hasValidCredentials();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hasCookie }));
    return;
  }

  // Push listener status
  if (req.method === 'GET' && req.url === '/push-status') {
    const pushClient = tool.getPushClient();
    const status = pushClient
      ? {
          connected: pushClient.isConnected(),
          state: pushClient.getState(),
          connectionId: pushClient.getConnectionId(),
          lastEventTime: pushClient.getLastEventTime()
            ? new Date(pushClient.getLastEventTime()!).toISOString()
            : null,
          eventCount: pushClient.getEventCount(),
        }
      : { connected: false, state: 'disconnected', connectionId: null, lastEventTime: null, eventCount: 0 };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  // Browser-based cookie extraction page
  if (req.method === 'GET' && req.url === '/extract-cookie') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(extractCookieHtml(port));
    return;
  }

  // Server-Sent Events endpoint for real-time push events
  if (req.method === 'GET' && req.url === '/events/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n');
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // Alexa directive endpoint — the Lambda proxy POSTs here
  if (req.method === 'POST' && req.url === '/directive') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const directive: AlexaMessage = JSON.parse(body);
        const response = await handler(directive);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    });
    return;
  }

  // Agent tool endpoint — direct agent actions
  if (req.method === 'POST' && req.url === '/action') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const action = JSON.parse(body);
        const result = await tool.execute(action);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    });
    return;
  }

  // Auto-poll status & control
  if (req.method === 'GET' && req.url === '/auto-poll') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      enabled: autoPollTimer !== null,
      intervalMs: autoPollIntervalMs,
      intervalMinutes: Math.round(autoPollIntervalMs / 60000),
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/auto-poll') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const { enabled, intervalMinutes } = JSON.parse(body);
        if (typeof intervalMinutes === 'number' && intervalMinutes > 0) {
          autoPollIntervalMs = intervalMinutes * 60 * 1000;
        }
        if (enabled === false) {
          stopAutoPoll();
        } else if (enabled === true) {
          startAutoPoll(autoPollIntervalMs);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          enabled: autoPollTimer !== null,
          intervalMs: autoPollIntervalMs,
          intervalMinutes: Math.round(autoPollIntervalMs / 60000),
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });
    return;
  }

  // State history query — used by the frontend to get historical readings for sparklines
  if (req.method === 'GET' && req.url?.startsWith('/state-history')) {
    const url = new URL(req.url, `http://localhost:${port}`);
    const deviceId = url.searchParams.get('deviceId') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const startTime = url.searchParams.get('startTime') || undefined;

    try {
      const result = await tool.execute({
        type: 'query_state_history',
        deviceId,
        startTime,
        limit,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.success ? result.data : { error: result.error }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  // Static file serving (frontend)
  if (req.method === 'GET' && req.url) {
    if (serveStaticFile(req.url, res)) return;
  }

  res.writeHead(404);
  res.end('Not found');
});

/**
 * Returns the HTML page that extracts cookies from alexa.amazon.com.
 *
 * How it works:
 * 1. User opens alexa.amazon.com in the same browser and logs in.
 * 2. User opens this page (http://localhost:<port>/extract-cookie).
 * 3. Page runs a bookmarklet-style JS snippet in an iframe (or the user
 *    drags the bookmarklet to the alexa tab) to grab document.cookie.
 * 4. Cookie is POSTed back to the local server via /action.
 *
 * Since we can't read cross-origin cookies directly, we provide two methods:
 *   A) A bookmarklet the user drags to their bookmark bar and clicks while
 *      on alexa.amazon.com (most reliable).
 *   B) A "paste cookie" text area for manual copy-paste from DevTools.
 */
function extractCookieHtml(serverPort: number): string {
  const serverUrl = `http://localhost:${serverPort}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Alexa Cookie Extractor</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           max-width: 640px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
    h1 { font-size: 1.4rem; margin-bottom: 8px; }
    p, li { line-height: 1.6; font-size: 0.95rem; }
    .section { margin: 24px 0; padding: 16px; border: 1px solid #ddd; border-radius: 8px; }
    .section h2 { font-size: 1.1rem; margin-bottom: 12px; }
    textarea { width: 100%; height: 100px; font-family: monospace; font-size: 0.85rem;
               padding: 8px; border: 1px solid #ccc; border-radius: 4px; resize: vertical; }
    button { padding: 10px 20px; font-size: 0.95rem; cursor: pointer; border: none;
             border-radius: 6px; color: #fff; background: #0073e6; margin-top: 8px; }
    button:hover { background: #005bb5; }
    .bookmarklet { display: inline-block; padding: 8px 16px; background: #333; color: #fff;
                   text-decoration: none; border-radius: 6px; font-size: 0.9rem; margin: 8px 0; }
    .bookmarklet:hover { background: #555; }
    #status { margin-top: 12px; padding: 10px; border-radius: 4px; display: none; }
    #status.success { display: block; background: #d4edda; color: #155724; }
    #status.error { display: block; background: #f8d7da; color: #721c24; }
    #status.info { display: block; background: #cce5ff; color: #004085; }
    ol { padding-left: 20px; margin: 8px 0; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Alexa Cookie Extractor</h1>
  <p>Extract your Amazon session cookie to control Alexa devices.</p>

  <div class="section">
    <h2>Method 1: Network Tab (Recommended)</h2>
    <p><strong>Important:</strong> The Alexa API requires HttpOnly cookies that JavaScript
       cannot access. You must copy them from the Network tab.</p>
    <ol>
      <li>Open <a href="https://alexa.amazon.com" target="_blank">alexa.amazon.com</a> and log in.</li>
      <li>Open DevTools (<code>Cmd+Option+I</code> / <code>F12</code>) &rarr; <strong>Network</strong> tab.</li>
      <li>Refresh the page (<code>Cmd+R</code>).</li>
      <li>Click the <strong>first request</strong> to <code>alexa.amazon.com</code>.</li>
      <li>In <strong>Headers</strong> &rarr; <strong>Request Headers</strong>, find the <code>Cookie:</code> header.</li>
      <li>Right-click the value &rarr; <strong>Copy value</strong>.</li>
      <li>Paste below and click Submit.</li>
    </ol>
    <textarea id="cookie-input" placeholder="Paste the full Cookie header value here..."></textarea>
    <br/>
    <button onclick="submitCookie()">Submit Cookie</button>
  </div>

  <div class="section">
    <h2>Method 2: Bookmarklet (Quick Refresh)</h2>
    <p>This captures non-HttpOnly cookies only. Use as a quick refresh if the full
       cookie is already stored and only non-HttpOnly cookies have changed.</p>
    <ol>
      <li>Drag this link to your bookmark bar:
        <a class="bookmarklet" href="javascript:void(fetch('${serverUrl}/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'set_alexa_cookie',cookie:document.cookie})}).then(r=>r.json()).then(d=>alert(d.success?'Cookie sent! Stored: '+d.data.stored+', Valid: '+d.data.valid:'Error: '+d.error)).catch(e=>alert('Failed: '+e.message)))">
          Send Alexa Cookie
        </a>
      </li>
      <li>Go to <a href="https://alexa.amazon.com" target="_blank">alexa.amazon.com</a> and click it.</li>
    </ol>
  </div>

  <div id="status"></div>

  <script>
    async function submitCookie() {
      const cookie = document.getElementById('cookie-input').value.trim();
      const status = document.getElementById('status');
      if (!cookie) {
        status.className = 'error';
        status.textContent = 'Please paste a cookie string first.';
        return;
      }
      status.className = 'info';
      status.textContent = 'Sending cookie...';
      try {
        const res = await fetch('${serverUrl}/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'set_alexa_cookie', cookie }),
        });
        const data = await res.json();
        if (data.success) {
          status.className = 'success';
          status.textContent = 'Cookie stored! Valid: ' + data.data.valid +
            '. You can now use list_all_devices and control_account_device.';
        } else {
          status.className = 'error';
          status.textContent = 'Error: ' + data.error;
        }
      } catch (e) {
        status.className = 'error';
        status.textContent = 'Failed to connect: ' + e.message;
      }
    }
  </script>
</body>
</html>`;
}


const port = config.localServerPort;
server.listen(port, () => {
  console.log(`Alexa Agent Tool server running on http://localhost:${port}`);
  console.log(`  Storage: ${config.storageBackend}${config.storageBackend === 'sqlite' ? ` (${config.sqlitePath})` : ''}`);
  console.log(`  Endpoints:`);
  console.log(`    GET  /              — web frontend`);
  console.log(`    GET  /events/stream — SSE real-time event stream`);
  console.log(`    POST /directive     — receives forwarded Alexa directives`);
  console.log(`    POST /action        — receives agent tool actions`);
  console.log(`    GET  /health        — health check`);
  console.log(`    GET  /cookie-status — unofficial API cookie status`);
  console.log(`    GET  /push-status   — push listener connection status`);
  console.log(`    GET  /extract-cookie — browser-based cookie extraction page`);

  // Auto-start push listener if a cookie is already stored,
  // then auto-poll device states in the background so the frontend
  // can render cached states immediately on first page load.
  (async () => {
    try {
      const result = await tool.execute({ type: 'start_push_listener' });
      if (result.success) {
        console.log(`  Push listener: connected`);
      } else {
        console.log(`  Push listener: ${result.error}`);
      }
    } catch (err) {
      console.log(`  Push listener: not started (no cookie configured)`);
    }

    // Background poll — runs after push listener setup so we don't
    // delay server startup.  Fire-and-forget; errors are logged but
    // don't crash the server.
    try {
      console.log(`  Background poll: starting...`);
      const pollResult = await tool.execute({ type: 'poll_all_states' });
      if (pollResult.success) {
        const d = pollResult.data as { polledCount: number; errorCount: number };
        console.log(`  Background poll: ${d.polledCount} devices polled (${d.errorCount} unreachable)`);
      } else {
        console.log(`  Background poll: ${pollResult.error}`);
      }
    } catch (err) {
      console.log(`  Background poll: failed — ${err instanceof Error ? err.message : String(err)}`);
    }

    // Start auto-poll timer (continues polling at the configured interval)
    if (config.autoPollIntervalMinutes > 0) {
      startAutoPoll();
      console.log(`  Auto-poll: every ${config.autoPollIntervalMinutes} minutes`);
    }
  })();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  stopAutoPoll();
  tool.close();
  server.close();
  process.exit(0);
});
