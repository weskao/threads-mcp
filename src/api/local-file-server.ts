import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Default TCP port for the local file server. */
export const LOCAL_FILE_SERVER_DEFAULT_PORT = 51847;

/**
 * Maps common media file extensions to their MIME types.
 */
const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

/**
 * Resolves the best public IP address for this machine.
 *
 * Returns the first non-internal IPv4 address found, falling back to
 * '127.0.0.1' when the machine has no external interfaces.
 */
function detectPublicIp(): string {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Queries the ngrok local API (http://127.0.0.1:4040/api/tunnels) for an
 * active HTTPS tunnel forwarding to the given port.
 *
 * Returns the ngrok public base URL (e.g. "https://xxxx.ngrok-free.app")
 * when a matching tunnel is found, or `null` otherwise (ngrok not running,
 * no matching tunnel, or any network/parse error).
 */
async function detectNgrokUrl(port: number): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    const res = await fetch('http://127.0.0.1:4040/api/tunnels', {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json() as {
      tunnels?: Array<{ public_url: string; proto: string; config: { addr: string } }>;
    };
    const tunnel = (data.tunnels ?? []).find(
      (t) => t.proto === 'https' && t.config.addr.includes(String(port)),
    );
    return tunnel?.public_url ?? null;
  } catch {
    return null;
  }
}

/**
 * A lightweight HTTP server that serves a single local file at `GET /file`.
 *
 * Intended use: the Threads API requires publicly accessible media URLs and
 * cannot accept local file paths. `LocalFileServer` bridges this gap by
 * temporarily exposing a local file over HTTP so that the Threads API can
 * fetch it.
 *
 * **Internet reachability caveat:** the machine running the MCP server must
 * be reachable from the internet on the configured port. If the server is
 * behind NAT or a firewall, the URL returned by `start()` will not be
 * accessible to the Threads API. Use a tunnel (e.g. ngrok) or deploy to a
 * publicly accessible host in that case.
 */
export class LocalFileServer {
  private readonly port: number;
  private server: http.Server | null = null;

  /** The public URL of the served file, or `null` if the server is not running. */
  url: string | null = null;

  /**
   * @param port - TCP port to listen on. Defaults to `LOCAL_FILE_SERVER_DEFAULT_PORT`.
   */
  constructor(port: number = LOCAL_FILE_SERVER_DEFAULT_PORT) {
    this.port = port;
  }

  /**
   * Starts the HTTP server and serves `filePath` at `GET /file`.
   *
   * @param filePath - Absolute path to the file to serve.
   * @returns The public URL at which the file is accessible
   *          (e.g. `http://<ip>:<port>/file`).
   * @throws If `filePath` does not exist.
   * @throws If the server is already running.
   */
  start(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        return reject(new Error('LocalFileServer is already running. Call stop() before starting again.'));
      }

      if (!fs.existsSync(filePath)) {
        return reject(new Error(`File not found: ${filePath}`));
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

      const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/file') {
          try {
            const stat = fs.statSync(filePath);
            res.writeHead(200, {
              'Content-Type': contentType,
              'Content-Length': stat.size,
            });
            const stream = fs.createReadStream(filePath);
            stream.on('error', (streamErr) => {
              // Headers already sent — destroy the connection rather than
              // attempting to write an error status.
              res.destroy(streamErr);
            });
            stream.pipe(res);
          } catch {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
          }
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        }
      });

      server.on('error', (err) => {
        this.server = null;
        this.url = null;
        reject(err);
      });

      server.listen(this.port, '127.0.0.1', () => {
        this.server = server;
        void detectNgrokUrl(this.port).then((ngrokBase) => {
          if (ngrokBase) {
            this.url = `${ngrokBase}/file`;
          } else {
            const ip = detectPublicIp();
            this.url = `http://${ip}:${this.port}/file`;
          }
          resolve(this.url);
        });
      });
    });
  }

  /**
   * Closes the HTTP server gracefully.
   *
   * Resolves once the server has fully shut down. If the server is not
   * running, resolves immediately.
   */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        return resolve();
      }

      this.server.close((err) => {
        if (err) {
          return reject(err);
        }
        this.server = null;
        this.url = null;
        resolve();
      });
      // Drain lingering keep-alive connections so stop() does not hang.
      // closeIdleConnections is available in Node 18.2+.
      this.server.closeIdleConnections?.();
    });
  }
}
