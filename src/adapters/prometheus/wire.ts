/** Prometheus remote_write: protobuf WriteRequest subset + unframed snappy. */

export interface PromSample {
  value: number;
  timestamp: number;
}

export interface PromSeries {
  labels: Record<string, string>;
  samples: PromSample[];
}

function encodeVarint(n: number): Buffer {
  const out: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

function encodeKey(field: number, wire: number): Buffer {
  return encodeVarint((field << 3) | wire);
}

function encodeString(field: number, s: string): Buffer {
  const raw = Buffer.from(s, "utf8");
  return Buffer.concat([encodeKey(field, 2), encodeVarint(raw.length), raw]);
}

function encodeBytes(field: number, raw: Buffer): Buffer {
  return Buffer.concat([encodeKey(field, 2), encodeVarint(raw.length), raw]);
}

function encodeDouble(field: number, value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value, 0);
  return Buffer.concat([encodeKey(field, 1), buf]);
}

function encodeInt64(field: number, value: number): Buffer {
  let v = BigInt(Math.trunc(value));
  const out: number[] = [];
  const neg = v < 0n;
  if (neg) v = (1n << 64n) + v;
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.concat([encodeKey(field, 0), Buffer.from(out)]);
}

function encodeLabel(name: string, value: string): Buffer {
  return Buffer.concat([encodeString(1, name), encodeString(2, value)]);
}

function encodeSample(sample: PromSample): Buffer {
  return Buffer.concat([encodeDouble(1, sample.value), encodeInt64(2, sample.timestamp)]);
}

function encodeSeries(series: PromSeries): Buffer {
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(series.labels)) parts.push(encodeBytes(1, encodeLabel(k, v)));
  for (const s of series.samples) parts.push(encodeBytes(2, encodeSample(s)));
  return Buffer.concat(parts);
}

export function encodeWriteRequest(series: PromSeries[]): Buffer {
  return Buffer.concat(series.map((s) => encodeBytes(1, encodeSeries(s))));
}

class ProtoReader {
  constructor(
    readonly buf: Buffer,
    public o = 0,
  ) {}
  done(): boolean {
    return this.o >= this.buf.length;
  }
  varint(): number {
    let shift = 0n;
    let n = 0n;
    while (this.o < this.buf.length) {
      const b = BigInt(this.buf[this.o++]!);
      n |= (b & 0x7fn) << shift;
      if ((b & 0x80n) === 0n) return Number(n);
      shift += 7n;
    }
    return Number(n);
  }
  bytes(): Buffer {
    const n = this.varint();
    const slice = this.buf.subarray(this.o, this.o + n);
    this.o += n;
    return Buffer.from(slice);
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.o += 8;
    else if (wire === 2) this.o += this.varint();
    else if (wire === 5) this.o += 4;
  }
}

function decodeLabel(buf: Buffer): { name: string; value: string } {
  const r = new ProtoReader(buf);
  let name = "";
  let value = "";
  while (!r.done()) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) name = r.bytes().toString("utf8");
    else if (field === 2 && wire === 2) value = r.bytes().toString("utf8");
    else r.skip(wire);
  }
  return { name, value };
}

function decodeSample(buf: Buffer): PromSample {
  const r = new ProtoReader(buf);
  let value = 0;
  let timestamp = 0;
  while (!r.done()) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 1) {
      value = r.buf.readDoubleLE(r.o);
      r.o += 8;
    } else if (field === 2 && wire === 0) timestamp = r.varint();
    else r.skip(wire);
  }
  return { value, timestamp };
}

function decodeSeries(buf: Buffer): PromSeries {
  const r = new ProtoReader(buf);
  const labels: Record<string, string> = {};
  const samples: PromSample[] = [];
  while (!r.done()) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) {
      const lab = decodeLabel(r.bytes());
      if (lab.name) labels[lab.name] = lab.value;
    } else if (field === 2 && wire === 2) samples.push(decodeSample(r.bytes()));
    else r.skip(wire);
  }
  return { labels, samples };
}

export function decodeWriteRequest(buf: Buffer): PromSeries[] {
  const r = new ProtoReader(buf);
  const out: PromSeries[] = [];
  while (!r.done()) {
    const tag = r.varint();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) out.push(decodeSeries(r.bytes()));
    else r.skip(wire);
  }
  return out;
}

export function snappyCompress(input: Buffer): Buffer {
  const header = encodeVarint(input.length);
  const chunks: Buffer[] = [header];
  for (let i = 0; i < input.length; i += 60) {
    const slice = input.subarray(i, i + 60);
    chunks.push(Buffer.from([(slice.length - 1) << 2]), slice);
  }
  return Buffer.concat(chunks);
}

export function snappyDecompress(input: Buffer): Buffer {
  const r = new ProtoReader(input);
  const expected = r.varint();
  const out = Buffer.alloc(Math.max(expected, 0));
  let w = 0;
  while (r.o < input.length && w < out.length) {
    const tag = input[r.o++]!;
    const kind = tag & 3;
    if (kind === 0) {
      let len = (tag >> 2) + 1;
      if (tag >> 2 >= 60) {
        const extra = (tag >> 2) - 59;
        len = 0;
        for (let i = 0; i < extra; i++) len |= (input[r.o++] ?? 0) << (8 * i);
        len += 1;
      }
      input.copy(out, w, r.o, r.o + len);
      r.o += len;
      w += len;
    } else {
      let length = 0;
      let offset = 0;
      if (kind === 1) {
        length = (tag >> 2) + 4;
        offset = input[r.o++] ?? 0;
      } else if (kind === 2) {
        length = (tag >> 2) + 1;
        offset = (input[r.o] ?? 0) | ((input[r.o + 1] ?? 0) << 8);
        r.o += 2;
      } else {
        length = (tag >> 2) + 1;
        offset = input.readUInt32LE(r.o);
        r.o += 4;
      }
      for (let i = 0; i < length && w < out.length; i++) {
        out[w] = out[w - offset] ?? 0;
        w += 1;
      }
    }
  }
  return out.subarray(0, expected || w);
}
