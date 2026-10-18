/**
 * Minimal RFC 6455 WebSocket implementation used only by tests: the fake CDP
 * upstream needs a WS server, and the gateway tests need a WS client. No
 * extensions, no fragmentation reassembly beyond what CDP traffic requires.
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function wsAcceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

export interface WsFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

export function buildFrame(opcode: number, payload: Buffer, masked: boolean): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  if (!masked) return Buffer.concat([header, payload]);

  header[1] = (header[1] as number) | 0x80;
  const mask = randomBytes(4);
  const maskedPayload = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) {
    maskedPayload[i] = (payload[i] as number) ^ (mask[i % 4] as number);
  }
  return Buffer.concat([header, mask, maskedPayload]);
}

export class WsFrameParser {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): WsFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: WsFrame[] = [];
    for (;;) {
      const frame = this.tryParse();
      if (!frame) break;
      frames.push(frame);
    }
    return frames;
  }

  private tryParse(): WsFrame | undefined {
    const buf = this.buffer;
    if (buf.length < 2) return undefined;
    const fin = ((buf[0] as number) & 0x80) !== 0;
    const opcode = (buf[0] as number) & 0x0f;
    const masked = ((buf[1] as number) & 0x80) !== 0;
    let length = (buf[1] as number) & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buf.length < 4) return undefined;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return undefined;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WS frame too large');
      length = Number(big);
      offset = 10;
    }

    let maskKey: Buffer | undefined;
    if (masked) {
      if (buf.length < offset + 4) return undefined;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + length) return undefined;

    let payload = buf.subarray(offset, offset + length);
    if (maskKey) {
      const unmasked = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) {
        unmasked[i] = (payload[i] as number) ^ (maskKey[i % 4] as number);
      }
      payload = unmasked;
    }
    this.buffer = Buffer.from(buf.subarray(offset + length));
    return { fin, opcode, payload: Buffer.from(payload) };
  }
}

export class WsConnection extends EventEmitter {
  private readonly parser = new WsFrameParser();
  private closeSent = false;
  private closed = false;

  /** `masked` must be true for client connections (RFC 6455 requirement). */
  constructor(
    private readonly socket: Socket,
    private readonly masked: boolean,
  ) {
    super();
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.emitClose());
    // TCP half-close (peer destroyed or ended without a WS close frame):
    // finish our side too so the socket cannot linger half-open.
    socket.on('end', () => {
      this.close();
      socket.end();
      this.emitClose();
    });
    socket.on('error', () => {
      /* surface as close; tests assert on close */
      this.emitClose();
    });
  }

  feedHead(head: Buffer): void {
    if (head.length > 0) this.onData(head);
  }

  send(data: string): void {
    this.socket.write(buildFrame(0x1, Buffer.from(data, 'utf8'), this.masked));
  }

  close(code = 1000): void {
    if (this.closeSent) return;
    this.closeSent = true;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.socket.write(buildFrame(0x8, payload, this.masked));
  }

  destroy(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    let frames: WsFrame[];
    try {
      frames = this.parser.push(chunk);
    } catch {
      this.socket.destroy();
      return;
    }
    for (const frame of frames) {
      switch (frame.opcode) {
        case 0x1:
        case 0x2:
          this.emit('message', frame.payload.toString('utf8'));
          break;
        case 0x8:
          this.close();
          this.socket.end();
          this.emitClose();
          break;
        case 0x9:
          this.socket.write(buildFrame(0xa, frame.payload, this.masked));
          break;
        default:
          break;
      }
    }
  }

  private emitClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

/** Completes the server side of the WS handshake on an 'upgrade' event. */
export function completeServerHandshake(request: http.IncomingMessage, socket: Socket): void {
  const key = String(request.headers['sec-websocket-key'] ?? '');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n` +
      '\r\n',
  );
}

/**
 * Client-side WS connect. Rejects with the HTTP status when the server answers
 * anything other than 101 (e.g. the gateway's 401/403 for a denied upgrade).
 */
export function connectWs(
  url: string,
  headers: Record<string, string> = {},
): Promise<WsConnection> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const key = randomBytes(16).toString('base64');
    const request = http.request({
      host: parsed.hostname,
      port: parsed.port === '' ? 80 : Number(parsed.port),
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        ...headers,
        connection: 'upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
      },
    });
    request.on('upgrade', (response, socket, head) => {
      if (response.headers['sec-websocket-accept'] !== wsAcceptKey(key)) {
        socket.destroy();
        reject(new Error('invalid Sec-WebSocket-Accept'));
        return;
      }
      const connection = new WsConnection(socket, true);
      connection.feedHead(head);
      resolve(connection);
    });
    request.on('response', (response) => {
      response.resume();
      reject(new Error(`upgrade rejected: ${response.statusCode}`));
    });
    request.on('error', reject);
    request.end();
  });
}
