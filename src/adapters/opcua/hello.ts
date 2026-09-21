/** Minimal OPC UA Hello/Acknowledge framing (not a full SecureChannel). */

export function parseEndpoint(endpoint: string): { host: string; port: number } {
  const raw = endpoint.replace(/^opc\.tcp:\/\//i, "");
  const [hostPart, portPart] = raw.split(":");
  const host = (hostPart ?? "127.0.0.1").replace(/\/.*$/, "");
  const port = portPart ? Number.parseInt(portPart, 10) : 4840;
  if (!host || Number.isNaN(port)) throw new Error(`Invalid OPC UA endpoint: ${endpoint}`);
  return { host, port };
}

export function encodeHello(endpointUrl: string): Buffer {
  const url = Buffer.from(endpointUrl, "utf8");
  const body = Buffer.alloc(24 + url.length);
  let o = 0;
  body.writeUInt32LE(0, o);
  o += 4;
  body.writeUInt32LE(65535, o);
  o += 4;
  body.writeUInt32LE(65535, o);
  o += 4;
  body.writeUInt32LE(0, o);
  o += 4;
  body.writeUInt32LE(0, o);
  o += 4;
  body.writeInt32LE(url.length, o);
  o += 4;
  url.copy(body, o);
  const header = Buffer.alloc(8);
  header.write("HELF", 0, 4, "ascii");
  header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

export function encodeAck(protocolVersion = 0): Buffer {
  const body = Buffer.alloc(20);
  body.writeUInt32LE(protocolVersion, 0);
  body.writeUInt32LE(65535, 4);
  body.writeUInt32LE(65535, 8);
  body.writeUInt32LE(0, 12);
  body.writeUInt32LE(0, 16);
  const header = Buffer.alloc(8);
  header.write("ACKF", 0, 4, "ascii");
  header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

export function decodeAck(buf: Buffer): { ok: boolean; messageType: string; protocolVersion?: number } {
  if (buf.length < 8) return { ok: false, messageType: "" };
  const messageType = buf.subarray(0, 3).toString("ascii");
  if (messageType === "ACK") {
    return { ok: true, messageType, protocolVersion: buf.length >= 12 ? buf.readUInt32LE(8) : 0 };
  }
  return { ok: false, messageType };
}
