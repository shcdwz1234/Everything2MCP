/** Castagnoli CRC-32C (reflected poly 0x82f63b78). Used by official Pulsar payload frames. */

const TABLE = (() => {
  const table = new Uint32Array(256);
  const poly = 0x82f63b78;
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ poly : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

export function crc32c(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** ITU test vector: CRC-32C("123456789") = 0xe3069283 */
export const CRC32C_CHECK = 0xe3069283;
