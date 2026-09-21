/** Cassandra native protocol v4 subset: STARTUP / READY / QUERY / RESULT. */

export const CASSANDRA_V4 = 0x04;
export const CASSANDRA_V4_RESPONSE = 0x84;
export const OPCODE_ERROR = 0x00;
export const OPCODE_STARTUP = 0x01;
export const OPCODE_READY = 0x02;
export const OPCODE_AUTHENTICATE = 0x03;
export const OPCODE_OPTIONS = 0x05;
export const OPCODE_SUPPORTED = 0x06;
export const OPCODE_QUERY = 0x07;
export const OPCODE_RESULT = 0x08;

export const RESULT_VOID = 1;
export const RESULT_ROWS = 2;
export const RESULT_SET_KEYSPACE = 3;
export const RESULT_SCHEMA_CHANGE = 5;
export const TYPE_VARCHAR = 0x000d;
export const CONSISTENCY_ONE = 0x0001;
export const ROWS_GLOBAL_TABLES = 0x0001;

export interface CassandraFrame {
  version: number;
  flags: number;
  stream: number;
  opcode: number;
  body: Buffer;
}

export function encodeString(value: string): Buffer {
  const raw = Buffer.from(value, "utf8");
  const head = Buffer.alloc(2);
  head.writeUInt16BE(raw.length, 0);
  return Buffer.concat([head, raw]);
}

export function encodeLongString(value: string): Buffer {
  const raw = Buffer.from(value, "utf8");
  const head = Buffer.alloc(4);
  head.writeInt32BE(raw.length, 0);
  return Buffer.concat([head, raw]);
}

export function encodeStringMap(map: Record<string, string>): Buffer {
  const keys = Object.keys(map);
  const head = Buffer.alloc(2);
  head.writeUInt16BE(keys.length, 0);
  return Buffer.concat([head, ...keys.flatMap((k) => [encodeString(k), encodeString(map[k]!)])]);
}

export function encodeBytes(value: string | null): Buffer {
  if (value === null) {
    const n = Buffer.alloc(4);
    n.writeInt32BE(-1, 0);
    return n;
  }
  const raw = Buffer.from(value, "utf8");
  const head = Buffer.alloc(4);
  head.writeInt32BE(raw.length, 0);
  return Buffer.concat([head, raw]);
}

export function encodeFrame(opcode: number, body: Buffer, stream = 0, response = false): Buffer {
  const header = Buffer.alloc(9);
  header.writeUInt8(response ? CASSANDRA_V4_RESPONSE : CASSANDRA_V4, 0);
  header.writeUInt8(0, 1);
  header.writeInt16BE(stream, 2);
  header.writeUInt8(opcode, 4);
  header.writeInt32BE(body.length, 5);
  return Buffer.concat([header, body]);
}

export function encodeStartup(options: Record<string, string> = { CQL_VERSION: "3.0.0" }): Buffer {
  return encodeFrame(OPCODE_STARTUP, encodeStringMap(options));
}

export function encodeReady(stream = 0): Buffer {
  return encodeFrame(OPCODE_READY, Buffer.alloc(0), stream, true);
}

export function encodeQuery(cql: string, stream = 1): Buffer {
  const cons = Buffer.alloc(3);
  cons.writeUInt16BE(CONSISTENCY_ONE, 0);
  cons.writeUInt8(0, 2);
  return encodeFrame(OPCODE_QUERY, Buffer.concat([encodeLongString(cql), cons]), stream);
}

export function encodeResultVoid(stream = 1): Buffer {
  const kind = Buffer.alloc(4);
  kind.writeInt32BE(RESULT_VOID, 0);
  return encodeFrame(OPCODE_RESULT, kind, stream, true);
}

export function encodeResultSetKeyspace(keyspace: string, stream = 1): Buffer {
  const kind = Buffer.alloc(4);
  kind.writeInt32BE(RESULT_SET_KEYSPACE, 0);
  return encodeFrame(OPCODE_RESULT, Buffer.concat([kind, encodeString(keyspace)]), stream, true);
}

export function encodeResultRows(
  keyspace: string,
  table: string,
  columns: string[],
  rows: Array<Record<string, unknown>>,
  stream = 1,
): Buffer {
  const parts: Buffer[] = [];
  const kind = Buffer.alloc(4);
  kind.writeInt32BE(RESULT_ROWS, 0);
  parts.push(kind);
  const flags = Buffer.alloc(8);
  flags.writeInt32BE(ROWS_GLOBAL_TABLES, 0);
  flags.writeInt32BE(columns.length, 4);
  parts.push(flags, encodeString(keyspace), encodeString(table));
  for (const col of columns) {
    const type = Buffer.alloc(2);
    type.writeUInt16BE(TYPE_VARCHAR, 0);
    parts.push(encodeString(col), type);
  }
  const count = Buffer.alloc(4);
  count.writeInt32BE(rows.length, 0);
  parts.push(count);
  for (const row of rows) {
    for (const col of columns) {
      const v = row[col];
      parts.push(encodeBytes(v === undefined || v === null ? null : String(v)));
    }
  }
  return encodeFrame(OPCODE_RESULT, Buffer.concat(parts), stream, true);
}

export function encodeError(message: string, stream = 1, code = 0x0000): Buffer {
  const err = Buffer.alloc(4);
  err.writeInt32BE(code, 0);
  return encodeFrame(OPCODE_ERROR, Buffer.concat([err, encodeString(message)]), stream, true);
}

export function decodeFrame(buf: Buffer): CassandraFrame | undefined {
  if (buf.length < 9) return undefined;
  const length = buf.readInt32BE(5);
  if (buf.length < 9 + length) return undefined;
  return {
    version: buf[0]!,
    flags: buf[1]!,
    stream: buf.readInt16BE(2),
    opcode: buf[4]!,
    body: buf.subarray(9, 9 + length),
  };
}

export function decodeString(buf: Buffer, offset: number): { value: string; next: number } {
  if (buf.length < offset + 2) return { value: "", next: offset };
  const n = buf.readUInt16BE(offset);
  const start = offset + 2;
  return { value: buf.subarray(start, start + n).toString("utf8"), next: start + n };
}

export function decodeLongString(buf: Buffer, offset = 0): { value: string; next: number } {
  if (buf.length < offset + 4) return { value: "", next: offset };
  const n = buf.readInt32BE(offset);
  const start = offset + 4;
  if (n < 0) return { value: "", next: start };
  return { value: buf.subarray(start, start + n).toString("utf8"), next: start + n };
}

export function decodeQueryCql(body: Buffer): string {
  return decodeLongString(body, 0).value;
}

export function decodeResult(body: Buffer): { kind: number; keyspace?: string; columns: string[]; rows: Array<Record<string, unknown>> } {
  if (body.length < 4) return { kind: 0, columns: [], rows: [] };
  const kind = body.readInt32BE(0);
  if (kind === RESULT_SET_KEYSPACE) {
    return { kind, keyspace: decodeString(body, 4).value, columns: [], rows: [] };
  }
  if (kind !== RESULT_ROWS) return { kind, columns: [], rows: [] };
  if (body.length < 12) return { kind, columns: [], rows: [] };
  const flags = body.readInt32BE(4);
  const columnCount = body.readInt32BE(8);
  let o = 12;
  if (flags & ROWS_GLOBAL_TABLES) {
    o = decodeString(body, o).next;
    o = decodeString(body, o).next;
  }
  const columns: string[] = [];
  for (let i = 0; i < columnCount; i++) {
    if (!(flags & ROWS_GLOBAL_TABLES)) {
      o = decodeString(body, o).next;
      o = decodeString(body, o).next;
    }
    const name = decodeString(body, o);
    o = name.next + 2;
    columns.push(name.value);
  }
  if (body.length < o + 4) return { kind, columns, rows: [] };
  const rowCount = body.readInt32BE(o);
  o += 4;
  const rows: Array<Record<string, unknown>> = [];
  for (let r = 0; r < rowCount; r++) {
    const row: Record<string, unknown> = {};
    for (const col of columns) {
      if (body.length < o + 4) break;
      const n = body.readInt32BE(o);
      o += 4;
      if (n < 0) row[col] = null;
      else {
        row[col] = body.subarray(o, o + n).toString("utf8");
        o += n;
      }
    }
    rows.push(row);
  }
  return { kind, columns, rows };
}
