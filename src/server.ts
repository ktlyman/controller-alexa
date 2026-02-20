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

  res.writeHead(404);
  res.end('Not found');
});

const port = config.localServerPort;
server.listen(port, () => {
  console.log(`Alexa Agent Tool server running on http://localhost:${port}`);
  console.log(`  Storage: ${config.storageBackend}${config.storageBackend === 'sqlite' ? ` (${config.sqlitePath})` : ''}`);
  console.log(`  Endpoints:`);
  console.log(`    POST /directive  — receives forwarded Alexa directives`);
  console.log(`    POST /action     — receives agent tool actions`);
  console.log(`    GET  /health     — health check`);
  console.log(`    GET  /cookie-status — unofficial API cookie status`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  tool.close();
  server.close();
  process.exit(0);
});
