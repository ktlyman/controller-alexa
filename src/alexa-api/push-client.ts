/**
 * AlexaPushClient — Real-time push event listener via Amazon's
 * WebSocket channel at dp-gw-na-js.amazon.com.
 *
 * Implements the FABE binary protocol over a raw WebSocket
 * connection using Node's built-in `https` module (no `ws` dep).
 *
 * Authentication: cookie-based (Type 1, A:H protocol).
 */

import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import { ALEXA_PUSH_WS_HOSTS, FABE } from './push-event-types';
import type { PushEvent, PushEventCommand } from './push-event-types';
import type { AlexaApiRegion } from './alexa-api-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PushClientOptions {
  /** Full cookie string from browser */
  cookie: string;
  /** Alexa region (NA, EU, FE) */
  region: AlexaApiRegion;
  /** Callback invoked for each parsed push event */
  onEvent: (event: PushEvent) => void;
  /** Optional callback for connection state changes */
  onStateChange?: (state: PushClientState) => void;
  /** Optional callback for errors */
  onError?: (error: Error) => void;
}

export type PushClientState =
  | 'disconnected'
  | 'connecting'
  | 'handshaking'
  | 'connected'
  | 'reconnecting';

interface ParsedMessage {
  service: string;       // 'FABE' | 'TUNE'
  messageType?: string;  // 'MSG' | 'ACK' | 'GWM' | ...
  channel?: number;
  messageId?: number;
  content: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeNumber(val: number, hexLen = 8): string {
  let s = val.toString(16);
  while (s.length < hexLen) s = '0' + s;
  return '0x' + s;
}

function generateUUID(): string {
  const template = 'rrrrrrrr-rrrr-4rrr-srrr-rrrrrrrrrrrr';
  const chars: string[] = [];
  for (let i = 0; i < 36; i++) {
    const c = template.charAt(i);
    if (c === 'r' || c === 's') {
      let d = Math.floor(16 * Math.random());
      if (c === 's') d = (d & 3) | 8;
      chars.push(d.toString(16));
    } else {
      chars.push(c);
    }
  }
  return chars.join('');
}

/**
 * Convert a potentially negative JS number to unsigned 32-bit.
 * For positive values > 2^32, preserves the full value (needed for carry extraction).
 */
function toUnsigned(value: number): number {
  if (value < 0) return 0xFFFFFFFF + value + 1;
  return value;
}

/**
 * Unsigned right-shift via repeated division (avoids JS `>>>` 32-bit truncation).
 * Preserves values > 2^32 so carry bits are not lost.
 */
function shiftRight(value: number, bits: number): number {
  let v = toUnsigned(value);
  while (bits > 0 && v !== 0) {
    v = Math.floor(v / 2);
    bits--;
  }
  return v;
}

/**
 * Compute the FABE protocol checksum.
 *
 * Accumulates bytes in big-endian 32-bit words with carry folding.
 * The exclusion window [excludeStart, excludeEnd) is skipped — this
 * is used to zero-out the checksum placeholder field while hashing.
 *
 * Port of alexa-remote2's `computeChecksum()`.
 */
function computeChecksum(buffer: Buffer, excludeStart: number, excludeEnd: number): number {
  const bytes = new Uint8Array(buffer);
  let sum = 0;
  let carry = 0;

  for (let i = 0; i < bytes.length; i++) {
    if (i >= excludeStart && i < excludeEnd) {
      i = excludeEnd - 1;
      continue;
    }

    const shiftAmount = ((i & 3) ^ 3) << 3;
    sum += toUnsigned(bytes[i] << shiftAmount);
    carry += shiftRight(sum, 32);
    sum = toUnsigned(sum & 0xFFFFFFFF);
  }

  while (carry) {
    sum += carry;
    carry = shiftRight(sum, 32);
    sum &= 0xFFFFFFFF;
  }

  return toUnsigned(sum);
}

function readHex(data: Buffer, index: number, length: number): number {
  let str = data.toString('ascii', index, index + length);
  if (str.startsWith('0x')) str = str.substring(2);
  return parseInt(str, 16);
}

function readString(data: Buffer, index: number, length: number): string {
  return data.toString('ascii', index, index + length);
}

function extractUbid(cookie: string): string | null {
  const match = cookie.match(/ubid-[a-z]+=([^;]+)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// WebSocket Frame Helpers (RFC 6455)
// ---------------------------------------------------------------------------

function encodeWebSocketFrame(payload: Buffer, opcode = 0x02): Buffer {
  const len = payload.length;
  let headerLen: number;

  if (len < 126) {
    headerLen = 6; // 2 base + 4 mask
  } else if (len < 65536) {
    headerLen = 8; // 2 base + 2 ext + 4 mask
  } else {
    headerLen = 14; // 2 base + 8 ext + 4 mask
  }

  const frame = Buffer.alloc(headerLen + len);
  // FIN + opcode
  frame[0] = 0x80 | opcode;

  let offset: number;
  if (len < 126) {
    frame[1] = 0x80 | len; // mask bit set
    offset = 2;
  } else if (len < 65536) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    frame[1] = 0x80 | 127;
    // write 8-byte length (high 4 bytes = 0 for our sizes)
    frame.writeUInt32BE(0, 2);
    frame.writeUInt32BE(len, 6);
    offset = 10;
  }

  // 4-byte random mask key (client MUST mask)
  const mask = crypto.randomBytes(4);
  mask.copy(frame, offset);
  offset += 4;

  // Masked payload
  for (let i = 0; i < len; i++) {
    frame[offset + i] = payload[i] ^ mask[i & 3];
  }

  return frame;
}

function createUpgradeKey(): { key: string; expected: string } {
  const keyBytes = crypto.randomBytes(16);
  const key = keyBytes.toString('base64');
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC175B18')
    .digest('base64');
  return { key, expected: accept };
}

// ---------------------------------------------------------------------------
// WebSocket Frame Parser (stateful, reassembles fragmented frames)
// ---------------------------------------------------------------------------

class WebSocketFrameParser {
  private buffer = Buffer.alloc(0);
  private onFrame: (opcode: number, payload: Buffer) => void;

  constructor(onFrame: (opcode: number, payload: Buffer) => void) {
    this.onFrame = onFrame;
  }

  feed(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.drain();
  }

  private drain(): void {
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      // const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0F;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7F;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return; // need more data
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        // High 32 bits should be 0 for reasonable sizes
        payloadLen = this.buffer.readUInt32BE(6);
        offset = 10;
      }

      if (masked) offset += 4; // server shouldn't mask, but handle it

      const totalFrameLen = offset + payloadLen;
      if (this.buffer.length < totalFrameLen) return; // need more data

      let payload = this.buffer.subarray(offset, offset + payloadLen);
      if (masked) {
        const maskKey = this.buffer.subarray(offset - 4, offset);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      this.buffer = this.buffer.subarray(totalFrameLen);
      this.onFrame(opcode, Buffer.from(payload));
    }
  }

  clear(): void {
    this.buffer = Buffer.alloc(0);
  }
}

// ---------------------------------------------------------------------------
// FABE Protocol Encoder
// ---------------------------------------------------------------------------

class FABEEncoder {
  private messageId: number;

  constructor() {
    this.messageId = Math.floor(1e9 * Math.random());
  }

  getMessageId(): number {
    return this.messageId;
  }

  /** Initial TUNE message for A:H protocol */
  encodeInitTune(): Buffer {
    return Buffer.from('0x99d4f71a 0x0000001d A:HTUNE');
  }

  /** Responding TUNE for A:H protocol */
  encodeTuneResponseAH(): Buffer {
    return Buffer.from(
      '0xa6f6a951 0x0000009c {"protocolName":"A:H","parameters":{"AlphaProtocolHandler.receiveWindowSize":"16","AlphaProtocolHandler.maxFragmentSize":"16000"}}TUNE',
    );
  }

  /** Responding TUNE for A:F protocol */
  encodeTuneResponseAF(): Buffer {
    return Buffer.from(
      '0xfe88bc52 0x0000009c {"protocolName":"A:F","parameters":{"AlphaProtocolHandler.receiveWindowSize":"16","AlphaProtocolHandler.maxFragmentSize":"16000"}}TUNE',
    );
  }

  /** INI handshake on channel 0x361 (A:H only) */
  encodeHandshake(): Buffer {
    this.messageId++;

    let msg = 'MSG 0x00000361 ';
    msg += encodeNumber(this.messageId) + ' f 0x00000001 ';
    const checksumStart = msg.length; // 39
    msg += '0x00000000 ';
    const checksumEnd = msg.length;   // 50
    msg += '0x0000009b ';
    msg += 'INI 0x00000003 1.0 0x00000024 ';
    msg += generateUUID();
    msg += ' ';
    msg += encodeNumber(Date.now(), 16);
    msg += ' END FABE';

    const buffer = Buffer.from(msg, 'ascii');
    const checksum = computeChecksum(buffer, checksumStart, checksumEnd);
    Buffer.from(encodeNumber(checksum)).copy(buffer, 39);
    return buffer;
  }

  /** REGISTER_CONNECTION on channel 0x362 (A:H format) */
  encodeRegisterAH(): Buffer {
    this.messageId++;

    let msg = 'MSG 0x00000362 ';
    msg += encodeNumber(this.messageId) + ' f 0x00000001 ';
    const checksumStart = msg.length;
    msg += '0x00000000 ';
    const checksumEnd = msg.length;
    msg += '0x00000109 ';
    msg += 'GWM MSG 0x0000b479 0x0000003b ';
    msg += 'urn:tcomm-endpoint:device:deviceType:0:deviceSerialNumber:0 ';
    msg += '0x00000041 ';
    msg += 'urn:tcomm-endpoint:service:serviceName:DeeWebsiteMessagingService ';
    msg += '{"command":"REGISTER_CONNECTION"}FABE';

    const buffer = Buffer.from(msg, 'ascii');
    const checksum = computeChecksum(buffer, checksumStart, checksumEnd);
    Buffer.from(encodeNumber(checksum)).copy(buffer, 39);
    return buffer;
  }

  /** PIN heartbeat on channel 0x65 (A:H format) */
  encodePingAH(): Buffer {
    this.messageId++;

    let msg = 'MSG 0x00000065 ';
    msg += encodeNumber(this.messageId) + ' f 0x00000001 ';
    const checksumStart = msg.length;
    msg += '0x00000000 ';
    const checksumEnd = msg.length;
    msg += '0x00000062 ';

    const headerBuf = Buffer.from(msg, 'ascii');

    // Build PIN payload: "PIN" + 4-byte flag + 8-byte timestamp + 4-byte len + UTF-16BE "Regular"
    const payload = 'Regular';
    const payloadSize = 3 + 4 + 8 + 4 + (2 * payload.length); // 33 bytes
    const pinBuf = Buffer.alloc(payloadSize);
    let offset = 0;

    pinBuf.write('PIN', offset, 'ascii');
    offset += 3;

    pinBuf.writeUInt32BE(0, offset);
    offset += 4;

    // Write 8-byte timestamp (ms since epoch, big-endian)
    const now = Date.now();
    pinBuf.writeUInt32BE(Math.floor(now / 0x100000000), offset);
    pinBuf.writeUInt32BE(now >>> 0, offset + 4);
    offset += 8;

    pinBuf.writeUInt32BE(payload.length, offset);
    offset += 4;

    // UTF-16BE "Regular"
    for (let i = 0; i < payload.length; i++) {
      pinBuf[offset + i * 2] = 0;
      pinBuf[offset + i * 2 + 1] = payload.charCodeAt(i);
    }

    const fabe = Buffer.from('FABE', 'ascii');

    // Total frame: 0x62 = 98 bytes. headerBuf.length should cover "MSG ... 0x00000062 "
    const frame = Buffer.alloc(headerBuf.length + payloadSize + fabe.length);
    headerBuf.copy(frame, 0);
    pinBuf.copy(frame, headerBuf.length);
    fabe.copy(frame, headerBuf.length + payloadSize);

    const checksum = computeChecksum(frame, checksumStart, checksumEnd);
    Buffer.from(encodeNumber(checksum)).copy(frame, 39);
    return frame;
  }
}

// ---------------------------------------------------------------------------
// FABE Protocol Parser
// ---------------------------------------------------------------------------

class FABEParser {
  /**
   * Parse a raw FABE message buffer (A:H text-based format).
   */
  parse(data: Buffer): ParsedMessage {
    const service = data.toString('ascii', data.length - 4, data.length);
    const message: ParsedMessage = { service, content: {} };

    if (service === 'TUNE') {
      return this.parseTune(data, message);
    }
    if (service === 'FABE') {
      return this.parseFabe(data, message);
    }

    return message;
  }

  private parseTune(data: Buffer, message: ParsedMessage): ParsedMessage {
    try {
      let idx = 0;
      // Skip checksum: "0xNNNNNNNN "
      idx += 11;
      // Skip content length: "0xNNNNNNNN "
      idx += 11;
      // Remaining is JSON content until "TUNE"
      const jsonStr = data.toString('ascii', idx, data.length - 4);
      if (jsonStr.startsWith('{')) {
        try { message.content = JSON.parse(jsonStr); } catch {}
      }
    } catch {}
    return message;
  }

  private parseFabe(data: Buffer, message: ParsedMessage): ParsedMessage {
    try {
      let idx = 0;
      message.messageType = readString(data, idx, 3);
      idx += 4; // "MSG "

      message.channel = readHex(data, idx, 10);
      idx += 11;

      message.messageId = readHex(data, idx, 10);
      idx += 11;

      // Skip flag + space
      idx += 2; // "f "

      // Skip seq
      idx += 11;
      // Skip checksum
      idx += 11;
      // Skip content length
      idx += 11;

      // Now at content start
      const contentType = readString(data, idx, 3);
      message.content.messageType = contentType;
      idx += 4; // type + space

      if (message.channel === FABE.GW_HANDSHAKE_CHANNEL) {
        this.parseHandshakeContent(data, idx, message);
      } else if (message.channel === FABE.GW_CHANNEL) {
        this.parseGWContent(data, idx, message);
      } else if (message.channel === FABE.CHANNEL_FOR_HEARTBEAT) {
        // PON response — store raw payload
        message.content.payloadData = data.subarray(idx, data.length - 4);
      }
    } catch {}

    return message;
  }

  private parseHandshakeContent(data: Buffer, idx: number, message: ParsedMessage): void {
    if (message.content.messageType === 'ACK') {
      try {
        let length = readHex(data, idx, 10);
        idx += 11;
        message.content.protocolVersion = readString(data, idx, length);
        idx += length + 1;

        length = readHex(data, idx, 10);
        idx += 11;
        message.content.connectionUUID = readString(data, idx, length);
        idx += length + 1;

        message.content.established = readHex(data, idx, 10);
        idx += 11;
        message.content.timestampINI = readHex(data, idx, 18);
        idx += 19;
        message.content.timestampACK = readHex(data, idx, 18);
      } catch {}
    }
  }

  private parseGWContent(data: Buffer, idx: number, message: ParsedMessage): void {
    if (message.content.messageType === 'GWM') {
      try {
        // Sub-message type (MSG)
        message.content.subMessageType = readString(data, idx, 3);
        idx += 4;

        // Sub-channel
        message.content.channel = readHex(data, idx, 10);
        idx += 11;

        if (message.content.channel === FABE.DEE_WEBSITE_MESSAGING) {
          // Destination URN
          let length = readHex(data, idx, 10);
          idx += 11;
          message.content.destinationIdentityUrn = readString(data, idx, length);
          idx += length + 1;

          // Source URN + payload
          length = readHex(data, idx, 10);
          idx += 11;
          const idData = readString(data, idx, length);
          idx += length + 1;

          // idData = "urn:...  {json}" separated by space
          const spaceIdx = idData.indexOf(' ');
          if (spaceIdx !== -1) {
            message.content.deviceIdentityUrn = idData.substring(0, spaceIdx);
            message.content.payload = idData.substring(spaceIdx + 1);
          } else {
            message.content.deviceIdentityUrn = idData;
          }

          // Fallback: read remaining data before FABE
          if (!message.content.payload) {
            message.content.payload = readString(data, idx, data.length - 4 - idx);
          }

          // Double-nested JSON parsing
          if (typeof message.content.payload === 'string' &&
              message.content.payload.startsWith('{')) {
            try {
              message.content.payload = JSON.parse(message.content.payload);
              if (message.content.payload?.payload &&
                  typeof message.content.payload.payload === 'string') {
                try {
                  message.content.payload.payload = JSON.parse(
                    message.content.payload.payload,
                  );
                } catch {}
              }
            } catch {}
          }
        }
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// AlexaPushClient
// ---------------------------------------------------------------------------

const PING_INTERVAL_MS = 180_000;  // 3 minutes
const PONG_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 100;

export class AlexaPushClient {
  private opts: PushClientOptions;
  private socket: import('net').Socket | null = null;
  private frameParser: WebSocketFrameParser | null = null;
  private fabeEncoder = new FABEEncoder();
  private fabeParser = new FABEParser();

  private state: PushClientState = 'disconnected';
  private msgCounter = 0;
  private protocolName = 'A:H';
  private retryCount = 0;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private initTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private lastEventTime: number | null = null;
  private eventCount = 0;
  private connectionId: string | null = null;

  constructor(opts: PushClientOptions) {
    this.opts = opts;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting' || this.state === 'handshaking') {
      return;
    }
    this.setState('connecting');
    this.connectionId = generateUUID();
    this.msgCounter = 0;
    this.fabeEncoder = new FABEEncoder();

    try {
      await this.openWebSocket();
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.cleanupTimers();
    this.retryCount = 0;

    if (this.socket) {
      try {
        // Send WebSocket close frame
        const closeFrame = Buffer.alloc(6);
        closeFrame[0] = 0x88; // FIN + close opcode
        closeFrame[1] = 0x82; // mask + 2 bytes payload
        const mask = crypto.randomBytes(4);
        mask.copy(closeFrame, 2);
        // Status code 1000 (normal closure), masked
        closeFrame[2 + 4] = (0x03 ^ mask[0]); // 0x03E8 = 1000
        closeFrame[2 + 5] = (0xE8 ^ mask[1]);
        this.socket.write(closeFrame);
      } catch {}
      this.socket.destroy();
      this.socket = null;
    }

    this.frameParser?.clear();
    this.frameParser = null;
    this.setState('disconnected');
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  getState(): PushClientState {
    return this.state;
  }

  getConnectionId(): string | null {
    return this.connectionId;
  }

  getLastEventTime(): number | null {
    return this.lastEventTime;
  }

  getEventCount(): number {
    return this.eventCount;
  }

  // -----------------------------------------------------------------------
  // WebSocket Connection
  // -----------------------------------------------------------------------

  private openWebSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const host = ALEXA_PUSH_WS_HOSTS[this.opts.region] ?? ALEXA_PUSH_WS_HOSTS.NA;
      const ubid = extractUbid(this.opts.cookie) ?? 'unknown';
      const serial = `${ubid}-${Date.now()}`;
      const path = `/?x-amz-device-type=${FABE.DEVICE_TYPE}&x-amz-device-serial=${serial}`;

      const origin = this.opts.region === 'NA'
        ? 'https://alexa.amazon.com'
        : this.opts.region === 'EU'
          ? 'https://alexa.amazon.co.uk'
          : 'https://alexa.amazon.co.jp';

      const { key } = createUpgradeKey();

      const reqOpts: https.RequestOptions = {
        hostname: host,
        port: 443,
        path,
        method: 'GET',
        headers: {
          'Connection': 'Upgrade',
          'Upgrade': 'websocket',
          'Host': host,
          'Origin': origin,
          'Pragma': 'no-cache',
          'Cache-Control': 'no-cache',
          'Cookie': this.opts.cookie,
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
      };

      const req = https.request(reqOpts);

      let settled = false;

      req.on('upgrade', (res: http.IncomingMessage, socket: import('net').Socket, head: Buffer) => {
        if (settled) return;
        settled = true;

        // Note: Amazon's push gateway returns a non-standard Sec-WebSocket-Accept
        // value, so we skip validation. The connection works correctly regardless.

        this.socket = socket;
        this.setupSocket(head);
        this.setState('handshaking');

        // Start init timeout — must complete handshake within 30s
        this.initTimer = setTimeout(() => {
          if (this.state !== 'connected') {
            this.emitError(new Error('Push connection init timeout'));
            this.handleDisconnect(4000, 'init timeout');
          }
        }, INIT_TIMEOUT_MS);

        // Send initial TUNE
        this.sendRaw(this.fabeEncoder.encodeInitTune());
        resolve();
      });

      req.on('response', (res: http.IncomingMessage) => {
        // Server responded with a regular HTTP response instead of upgrade
        if (settled) return;
        settled = true;
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          reject(new Error(
            `WebSocket upgrade rejected: HTTP ${res.statusCode} ${res.statusMessage}` +
            (body ? ` — ${body.substring(0, 200)}` : ''),
          ));
        });
      });

      req.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      });

      req.setTimeout(10_000, () => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(new Error('WebSocket connection timeout'));
      });

      // Must not have a body
      req.end();
    });
  }

  private setupSocket(initialData: Buffer): void {
    this.frameParser = new WebSocketFrameParser((opcode, payload) => {
      this.handleWebSocketFrame(opcode, payload);
    });

    // Feed any data that came with the upgrade
    if (initialData.length > 0) {
      this.frameParser.feed(initialData);
    }

    this.socket!.on('data', (data: Buffer) => {
      this.frameParser?.feed(data);
    });

    this.socket!.on('close', () => {
      this.handleDisconnect(1006, 'connection closed');
    });

    this.socket!.on('error', (err: Error) => {
      this.emitError(err);
      this.handleDisconnect(1006, err.message);
    });
  }

  // -----------------------------------------------------------------------
  // WebSocket Frame Handling
  // -----------------------------------------------------------------------

  private handleWebSocketFrame(opcode: number, payload: Buffer): void {
    switch (opcode) {
      case 0x01: // text
      case 0x02: // binary
        this.handleFABEMessage(payload);
        break;
      case 0x08: // close
        this.handleDisconnect(
          payload.length >= 2 ? payload.readUInt16BE(0) : 1000,
          payload.length > 2 ? payload.toString('utf8', 2) : '',
        );
        break;
      case 0x09: // ping (WS-level)
        this.sendPong(payload);
        break;
      case 0x0A: // pong (WS-level) — ignore
        break;
    }
  }

  private sendPong(pingPayload: Buffer): void {
    // WS pong = opcode 0x0A with same payload
    this.sendRaw(pingPayload, 0x0A);
  }

  // -----------------------------------------------------------------------
  // FABE Message Handling (state machine)
  // -----------------------------------------------------------------------

  private handleFABEMessage(data: Buffer): void {
    const message = this.fabeParser.parse(data);

    if (message.service === 'TUNE') {
      this.handleTune(message);
      return;
    }

    if (message.service !== 'FABE') return;

    // Route by channel
    if (message.channel === FABE.GW_HANDSHAKE_CHANNEL) {
      this.handleHandshakeMessage(message);
    } else if (message.channel === FABE.GW_CHANNEL) {
      this.handleGWMessage(message);
    } else if (message.channel === FABE.CHANNEL_FOR_HEARTBEAT) {
      this.handleHeartbeatMessage(message);
    }

    this.msgCounter++;
  }

  private handleTune(message: ParsedMessage): void {
    // Server sent TUNE — extract protocol name and send matching response
    const proto = message.content?.protocolName;
    if (proto === 'A:F') {
      this.protocolName = 'A:F';
      this.sendRaw(this.fabeEncoder.encodeTuneResponseAF());
    } else {
      this.protocolName = 'A:H';
      this.sendRaw(this.fabeEncoder.encodeTuneResponseAH());
    }

    // After 50ms, send handshake or register
    setTimeout(() => {
      if (this.protocolName === 'A:H') {
        // A:H: send INI on channel 0x361, wait for ACK, then REGISTER
        this.sendRaw(this.fabeEncoder.encodeHandshake());
      } else {
        // A:F: skip INI, send REGISTER directly
        this.sendRaw(this.fabeEncoder.encodeRegisterAH());
        this.startHeartbeat();
      }
    }, 50);
  }

  private handleHandshakeMessage(message: ParsedMessage): void {
    if (message.content?.messageType === 'ACK') {
      // A:H: INI was ACKed, now send REGISTER
      this.sendRaw(this.fabeEncoder.encodeRegisterAH());
      this.startHeartbeat();
    }
  }

  private handleGWMessage(message: ParsedMessage): void {
    if (message.content?.messageType !== 'GWM') return;
    if (message.content?.channel !== FABE.DEE_WEBSITE_MESSAGING) return;

    const payload = message.content.payload;
    if (!payload || typeof payload !== 'object') return;

    // Extract the push event
    const command = payload.command as string;
    if (!command) return;

    // Build the push event
    const innerPayload = (typeof payload.payload === 'object' && payload.payload !== null)
      ? payload.payload as Record<string, unknown>
      : {};

    // Extract device serial from dopplerId if present
    const dopplerId = innerPayload.dopplerId as { deviceSerialNumber?: string; deviceType?: string } | undefined;
    const keyInfo = innerPayload.key as { entryId?: string } | undefined;

    const event: PushEvent = {
      command: command as PushEventCommand,
      timestamp: Date.now(),
      payload: innerPayload,
      deviceSerial: dopplerId?.deviceSerialNumber ?? undefined,
      deviceType: dopplerId?.deviceType ?? undefined,
    };

    this.lastEventTime = Date.now();
    this.eventCount++;

    try {
      this.opts.onEvent(event);
    } catch (err) {
      this.emitError(
        new Error(`Push event handler error: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  }

  private handleHeartbeatMessage(message: ParsedMessage): void {
    // PON received — connection is alive
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }

    // First PON after handshake = connection established
    if (this.state !== 'connected') {
      if (this.initTimer) {
        clearTimeout(this.initTimer);
        this.initTimer = null;
      }
      this.retryCount = 0;
      this.setState('connected');
    }
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  private startHeartbeat(): void {
    // First ping after 100ms
    setTimeout(() => {
      this.sendPing();
    }, 100);

    // Then every 180s
    this.pingTimer = setInterval(() => {
      this.sendPing();
    }, PING_INTERVAL_MS);
  }

  private sendPing(): void {
    if (!this.socket || this.socket.destroyed) return;

    this.sendRaw(this.fabeEncoder.encodePingAH());

    // Start pong timeout
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      this.emitError(new Error('Push heartbeat pong timeout'));
      this.handleDisconnect(4002, 'pong timeout');
    }, PONG_TIMEOUT_MS);
  }

  // -----------------------------------------------------------------------
  // Send raw data as WebSocket binary frame
  // -----------------------------------------------------------------------

  private sendRaw(data: Buffer, opcode = 0x02): void {
    if (!this.socket || this.socket.destroyed) return;
    const frame = encodeWebSocketFrame(data, opcode);
    this.socket.write(frame);
  }

  // -----------------------------------------------------------------------
  // Disconnect & Reconnect
  // -----------------------------------------------------------------------

  private handleDisconnect(code: number, reason: string): void {
    this.cleanupTimers();

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    this.frameParser?.clear();
    this.frameParser = null;

    // Check for permanent failure (invalid cookie)
    if (code === 4001 && reason.startsWith('before - Could not find any')) {
      this.setState('disconnected');
      this.emitError(new Error('Push connection rejected: invalid cookie'));
      return;
    }

    // If we were already disconnected (user called disconnect()), don't reconnect
    if (this.state === 'disconnected') return;

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.retryCount >= MAX_RETRIES) {
      this.setState('disconnected');
      this.emitError(new Error(`Push connection failed after ${MAX_RETRIES} retries`));
      return;
    }

    this.retryCount++;
    const delaySec = Math.min(60, (this.retryCount * 5) + 5);
    this.setState('reconnecting');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      });
    }, delaySec * 1000);
  }

  // -----------------------------------------------------------------------
  // State & Error
  // -----------------------------------------------------------------------

  private setState(state: PushClientState): void {
    this.state = state;
    try {
      this.opts.onStateChange?.(state);
    } catch {}
  }

  private emitError(error: Error): void {
    try {
      this.opts.onError?.(error);
    } catch {}
  }

  private cleanupTimers(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    if (this.initTimer) { clearTimeout(this.initTimer); this.initTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }
}
