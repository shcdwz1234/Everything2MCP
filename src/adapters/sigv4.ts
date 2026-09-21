import { createHash, createHmac } from "node:crypto";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hmacSha256(key: string | Buffer, data: string | Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export function hmacSha1(key: string | Buffer, data: string | Buffer): Buffer {
  return createHmac("sha1", key).update(data).digest();
}

function uriEncode(value: string, encodeSlash = true): string {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return encodeSlash ? encoded : encoded.replace(/%2F/g, "/");
}

export interface AwsV4Input {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  accessKey: string;
  secretKey: string;
  region?: string;
  service?: string;
  amzDate?: string;
}

export interface AwsV4Result {
  authorization: string;
  amzDate: string;
  payloadHash: string;
  headers: Record<string, string>;
  canonicalRequest: string;
}

/** AWS Signature Version 4 (path-style S3 / compatible). */
export function signAwsV4(input: AwsV4Input): AwsV4Result {
  const parsed = new URL(input.url);
  const region = input.region ?? "us-east-1";
  const service = input.service ?? "s3";
  const amzDate = input.amzDate ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const payload = input.body ?? "";
  const payloadHash = sha256Hex(payload);
  const extra = { ...(input.headers ?? {}) };
  const host = parsed.host;
  const headerMap: Record<string, string> = {
    host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };
  for (const [k, v] of Object.entries(extra)) {
    headerMap[k.toLowerCase()] = v;
  }
  const signedNames = Object.keys(headerMap).sort();
  const canonicalHeaders = signedNames.map((k) => `${k}:${headerMap[k]!.trim()}\n`).join("");
  const signedHeaders = signedNames.join(";");
  const canonicalUri = uriEncode(parsed.pathname || "/", false) || "/";
  const queryPairs = [...parsed.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = queryPairs.map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmacSha256(`AWS4${input.secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = hmacSha256(kSigning, stringToSign).toString("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    authorization,
    amzDate,
    payloadHash,
    canonicalRequest,
    headers: {
      ...extra,
      authorization,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
    },
  };
}

/** Verify a request was signed with the given credentials (hermetic fake). */
export function verifyAwsV4(
  input: Omit<AwsV4Input, "accessKey" | "secretKey"> & { authorization?: string },
  accessKey: string,
  secretKey: string,
): boolean {
  const expected = signAwsV4({ ...input, accessKey, secretKey, amzDate: input.amzDate });
  const got = input.authorization ?? input.headers?.authorization ?? input.headers?.Authorization;
  return Boolean(got && got === expected.authorization);
}

/** Aliyun OSS Authorization: OSS AccessKeyId:base64(hmac-sha1). */
export function signOss(input: {
  method: string;
  bucket: string;
  key?: string;
  contentType?: string;
  date: string;
  accessKey: string;
  secretKey: string;
}): { authorization: string; date: string; headers: Record<string, string> } {
  const resource = input.key ? `/${input.bucket}/${input.key}` : `/${input.bucket}/`;
  const canonical = [input.method.toUpperCase(), "", input.contentType ?? "", input.date, resource].join("\n");
  const signature = hmacSha1(input.secretKey, canonical).toString("base64");
  const authorization = `OSS ${input.accessKey}:${signature}`;
  return {
    authorization,
    date: input.date,
    headers: { authorization, date: input.date, ...(input.contentType ? { "content-type": input.contentType } : {}) },
  };
}

/**
 * Azure Blob SharedKey (subset): HMAC-SHA256 of
 * VERB\\n\\ncontentType\\n\\nx-ms-date:date\\nx-ms-version:ver\\n/account/container[/blob]
 * Account key is base64. SAS tokens are NOT signed here — append `sasToken` on the URL instead.
 */
export function signAzureBlob(input: {
  method: string;
  account: string;
  container: string;
  blob?: string;
  contentType?: string;
  date: string;
  version?: string;
  accountKey: string;
}): { authorization: string; date: string; headers: Record<string, string> } {
  const version = input.version ?? "2020-10-02";
  const resource = `/${input.account}/${input.container}${input.blob ? `/${input.blob}` : ""}`;
  const canonicalHeaders = `x-ms-date:${input.date}\nx-ms-version:${version}\n`;
  const stringToSign = [
    input.method.toUpperCase(),
    "",
    input.contentType ?? "",
    "",
    canonicalHeaders + resource,
  ].join("\n");
  const key = Buffer.from(input.accountKey, "base64");
  const signature = hmacSha256(key, stringToSign).toString("base64");
  const authorization = `SharedKey ${input.account}:${signature}`;
  return {
    authorization,
    date: input.date,
    headers: {
      authorization,
      "x-ms-date": input.date,
      "x-ms-version": version,
      ...(input.contentType ? { "content-type": input.contentType } : {}),
    },
  };
}

export function verifyAzureBlob(
  input: {
    method: string;
    account: string;
    container: string;
    blob?: string;
    contentType?: string;
    date: string;
    version?: string;
    authorization?: string;
  },
  accountKey: string,
): boolean {
  const expected = signAzureBlob({ ...input, accountKey });
  return Boolean(input.authorization && input.authorization === expected.authorization);
}

export function verifyOss(
  input: {
    method: string;
    bucket: string;
    key?: string;
    contentType?: string;
    date: string;
    authorization?: string;
  },
  accessKey: string,
  secretKey: string,
): boolean {
  const expected = signOss({ ...input, accessKey, secretKey });
  return Boolean(input.authorization && input.authorization === expected.authorization);
}
