import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
 *
 * NOTE: The Threads API must be able to reach this URL over the public
 * internet. If the server is running behind NAT or a firewall without
 * port-forwarding, the returned URL will not be reachable by Threads and
 * media uploads will fail. Use a tunnel (e.g. ngrok) or a cloud-hosted
 * instance when the machine is not directly internet-accessible.
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
   * @param port - TCP port to listen on. Defaults to `3456`.
   */
  constructor(port: number = 3456) {
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

      server.listen(this.port, () => {
        this.server = server;
        const ip = detectPublicIp();
        this.url = `http://${ip}:${this.port}/file`;
        resolve(this.url);
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
