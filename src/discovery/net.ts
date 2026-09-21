import { createConnection } from "node:net";
import { createSocket } from "node:dgram";
import { assertHostAllowed } from "../runtime/ssrf.js";

export async function tcpExchange(
  host: string,
  port: number,
  payload: Buffer | null,
  timeoutMs: number,
  minBytes = 8,
): Promise<Buffer | undefined> {
  await assertHostAllowed(host);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host, port, timeout: timeoutMs });
    const done = (buf?: Buffer) => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(buf);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      if (payload && payload.length) socket.write(payload);
    });
    socket.on("data", (d) => {
      chunks.push(d);
      if (Buffer.concat(chunks).length >= minBytes) done(Buffer.concat(chunks));
    });
    socket.on("timeout", () => done(chunks.length ? Buffer.concat(chunks) : undefined));
    socket.on("error", () => done(undefined));
    socket.on("end", () => done(chunks.length ? Buffer.concat(chunks) : undefined));
    socket.on("close", () => {
      if (chunks.length) done(Buffer.concat(chunks));
    });
  });
}

export async function udpExchange(
  host: string,
  port: number,
  payload: Buffer,
  timeoutMs: number,
): Promise<Buffer | undefined> {
  await assertHostAllowed(host);
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(undefined);
    }, timeoutMs);
    socket.once("message", (msg) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(msg);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    socket.send(payload, port, host);
  });
}
