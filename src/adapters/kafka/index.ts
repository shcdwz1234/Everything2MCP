import { Kafka } from "kafkajs";
import { AdapterError } from "../../runtime/errors.js";
import type { AdapterHealth, McpToolSchema } from "../../runtime/types.js";
import type { ProtocolAdapter } from "../spi.js";
import { payloadToString, stringArray, stringField, timeoutMs } from "../helpers.js";
import { allowWriteFrom, assertCanWrite } from "../sql/common.js";

export interface KafkaConsumeOpts {
  groupId?: string;
  fromBeginning?: boolean;
  groupInstanceId?: string;
}

export interface KafkaTxnSnapshot {
  transactionalId: string;
  producerId: number;
  epoch: number;
  state: "empty" | "ready" | "in_txn";
}

export interface KafkaHandle {
  produce(topic: string, value: string, key?: string): Promise<void>;
  consumeOnce(
    topic: string,
    timeoutMs: number,
    opts?: KafkaConsumeOpts,
  ): Promise<{ topic: string; value: string; key?: string; groupId?: string }>;
  listTopics(): Promise<string[]>;
  groupSnapshot?(groupId: string): Promise<{ committed: Record<string, number> }>;
  producerCaps?: { idempotent?: boolean };
  /** Hermetic-only. Live KafkaJS handles omit these — txn tools stay E_UNSUPPORTED. */
  caps?: { hermeticTransactions?: boolean; staticMembership?: boolean; hermeticRebalance?: boolean };
  generationSnapshot?(): number;
  initTransactions?(transactionalId: string): Promise<KafkaTxnSnapshot>;
  beginTransaction?(): Promise<KafkaTxnSnapshot>;
  commitTransaction?(): Promise<KafkaTxnSnapshot>;
  abortTransaction?(): Promise<KafkaTxnSnapshot>;
  txnSnapshot?(): KafkaTxnSnapshot | undefined;
  close(): Promise<void>;
}

export const KAFKA_TXN_TOOLS = ["begin_transaction", "commit_transaction", "abort_transaction", "init_transactions"] as const;

export function kafkaProducerOptions(config: Record<string, unknown>): {
  idempotent?: boolean;
  maxInFlightRequests?: number;
} {
  if (config.idempotent === true) return { idempotent: true, maxInFlightRequests: 1 };
  return {};
}

export function kafkaTransactionalRequested(config: Record<string, unknown>): {
  requested: boolean;
  transactionalId?: string;
} {
  const id = stringField(config, "transactionalId") ?? stringField(config, "transactional.id");
  return {
    requested: Boolean(id) || config.transactional === true,
    transactionalId: id,
  };
}

export type KafkaConnectFn = (config: Record<string, unknown>) => Promise<KafkaHandle>;

/** In-memory group + InitProducerId stub. Not a Kafka broker / not EOS. */
export function createHermeticKafkaHandle(): KafkaHandle {
  const log = new Map<string, Array<{ topic: string; value: string; key?: string }>>();
  const committed = new Map<string, number>();
  const staticMembers = new Set<string>();
  const members = new Map<string, string>();
  let generation = 0;
  let txn: KafkaTxnSnapshot | undefined;
  return {
    caps: { hermeticTransactions: true, staticMembership: true, hermeticRebalance: true },
    async produce(topic, value, key) {
      const q = log.get(topic) ?? [];
      q.push({ topic, value, key });
      log.set(topic, q);
    },
    async consumeOnce(topic, _ms, opts) {
      const gid = opts?.groupId ?? "default";
      const ckey = `${gid}::${topic}`;
      const offset = committed.get(ckey) ?? 0;
      const q = log.get(topic) ?? [];
      if (offset >= q.length) {
        throw new AdapterError("E_TIMEOUT", `Timed out waiting for Kafka message on ${topic}`, { protocol: "kafka" });
      }
      committed.set(ckey, offset + 1);
      staticMembers.add(gid);
      if (opts?.groupInstanceId) {
        const prev = members.get(gid);
        if (prev !== opts.groupInstanceId) {
          generation += 1;
          members.set(gid, opts.groupInstanceId);
        }
      }
      return { ...q[offset]!, groupId: gid };
    },
    async listTopics() {
      return [...log.keys()];
    },
    async groupSnapshot(groupId) {
      const out: Record<string, number> = {};
      for (const [k, v] of committed.entries()) {
        const prefix = `${groupId}::`;
        if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
      }
      return { committed: out };
    },
    async initTransactions(transactionalId) {
      txn = { transactionalId, producerId: 1, epoch: 0, state: "ready" };
      return txn;
    },
    async beginTransaction() {
      if (!txn || txn.state === "empty") {
        throw new AdapterError("E_UNSUPPORTED", "init_transactions first (hermetic)", { protocol: "kafka" });
      }
      if (txn.state === "in_txn") {
        throw new AdapterError("E_CONFLICT", "hermetic transaction already open", { protocol: "kafka" });
      }
      txn = { ...txn, state: "in_txn" };
      return txn;
    },
    async commitTransaction() {
      if (!txn || txn.state !== "in_txn") {
        throw new AdapterError("E_UNSUPPORTED", "no open hermetic transaction", { protocol: "kafka" });
      }
      txn = { ...txn, epoch: txn.epoch + 1, state: "ready" };
      return txn;
    },
    async abortTransaction() {
      if (!txn || txn.state !== "in_txn") {
        throw new AdapterError("E_UNSUPPORTED", "no open hermetic transaction", { protocol: "kafka" });
      }
      txn = { ...txn, epoch: txn.epoch + 1, state: "ready" };
      return txn;
    },
    txnSnapshot() {
      return txn;
    },
    generationSnapshot() {
      return generation;
    },
    async close() {
      log.clear();
      txn = undefined;
    },
  };
}

function brokerList(config: Record<string, unknown>): string[] {
  const fromArr = stringArray(config.brokers);
  if (fromArr.length) return fromArr;
  const url = stringField(config, "url") ?? stringField(config, "broker");
  if (url) return [url.replace(/^kafka:\/\//i, "")];
  return [];
}

export async function connectKafka(config: Record<string, unknown>): Promise<KafkaHandle> {
  const brokers = brokerList(config);
  if (!brokers.length) throw new Error("Kafka adapter requires config.brokers");
  const kafka = new Kafka({
    clientId: stringField(config, "clientId") ?? "everything2mcp",
    brokers,
  });
  const producerOpts = kafkaProducerOptions(config);
  const producer = kafka.producer(producerOpts);
  await producer.connect();
  const groupId = stringField(config, "groupId") ?? "everything2mcp";
  return {
    producerCaps: { idempotent: producerOpts.idempotent === true },
    async produce(topic, value, key) {
      await producer.send({ topic, messages: [{ value, key }] });
    },
    async consumeOnce(topic, ms, opts) {
      const gid = opts?.groupId ?? groupId;
      const consumer = kafka.consumer({ groupId: gid });
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: opts?.fromBeginning !== false });
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new AdapterError("E_TIMEOUT", `Timed out waiting for Kafka message on ${topic}`, { protocol: "kafka" }),
              ),
            ms,
          );
          void consumer.run({
            eachMessage: async ({ message, topic: t }) => {
              clearTimeout(timer);
              resolve({
                topic: t,
                value: message.value?.toString("utf8") ?? "",
                key: message.key?.toString("utf8") ?? undefined,
                groupId: gid,
              });
            },
          });
        });
      } finally {
        await consumer.disconnect();
      }
    },
    async listTopics() {
      const admin = kafka.admin();
      await admin.connect();
      try {
        return admin.listTopics();
      } finally {
        await admin.disconnect();
      }
    },
    async close() {
      await producer.disconnect();
    },
  };
}

export class KafkaAdapter implements ProtocolAdapter {
  readonly protocol = "kafka";
  private handle: KafkaHandle | undefined;
  private topics: string[] = [];
  private defaultTopic = "";
  private groupId = "everything2mcp";
  private groupInstanceId = "";
  private idempotentRequested = false;
  private transactionalRequested = false;
  private transactionalId = "";
  private connected = false;
  private allowWrite = false;

  constructor(
    readonly id: string,
    private readonly connectFn: KafkaConnectFn = connectKafka,
  ) {}

  async connect(config: Record<string, unknown>): Promise<void> {
    if (!brokerList(config).length) {
      throw new Error("Kafka adapter requires config.brokers (or config.url)");
    }
    this.topics = stringArray(config.topics);
    this.defaultTopic = stringField(config, "topic") ?? this.topics[0] ?? "";
    if (this.defaultTopic && !this.topics.includes(this.defaultTopic)) this.topics.push(this.defaultTopic);
    this.groupId = stringField(config, "groupId") ?? "everything2mcp";
    this.groupInstanceId = stringField(config, "groupInstanceId") ?? stringField(config, "staticMemberId") ?? "";
    this.idempotentRequested = config.idempotent === true;
    const txn = kafkaTransactionalRequested(config);
    this.transactionalRequested = txn.requested;
    this.transactionalId = txn.transactionalId ?? "";
    this.allowWrite = allowWriteFrom(config);
    this.handle = await this.connectFn(config);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.handle) await this.handle.close();
    this.handle = undefined;
    this.connected = false;
  }

  async listTools(): Promise<McpToolSchema[]> {
    this.assertConnected();
    return [
      {
        name: "produce",
        description: "Produce a message to a Kafka topic (requires allowWrite=true)",
        inputSchema: {
          type: "object",
          properties: {
            topic: { type: "string" },
            payload: { description: "String or JSON value" },
            key: { type: "string" },
          },
          required: ["payload"],
          additionalProperties: false,
        },
      },
      {
        name: "consume_once",
        description: "Wait for a single record from a topic using a consumer group (offsets per groupId)",
        inputSchema: {
          type: "object",
          properties: {
            topic: { type: "string" },
            timeoutMs: { type: "integer", default: 5000 },
            groupId: { type: "string", description: "Override the registration consumer group" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "list_topics",
        description: "List configured (and if the handle supports it, cluster) topics",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      {
        name: "group_status",
        description:
          "Read-only consumer-group snapshot. consume_once is a one-shot join/leave. Does not implement cooperative rebalance, static membership, or transactions — group_status says so explicitly.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ];
  }

  async invoke(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    const handle = this.handle!;
    if ((KAFKA_TXN_TOOLS as readonly string[]).includes(toolName)) {
      const hermetic = handle.caps?.hermeticTransactions === true;
      if (!hermetic) {
        throw new AdapterError(
          "E_UNSUPPORTED",
          "Kafka transactions / EOS are not implemented on the live KafkaJS path. Hermetic memory handles expose a local InitProducerId state machine; a real cluster still has no transaction coordinator.",
          { protocol: "kafka" },
        );
      }
      if (toolName !== "init_transactions") assertCanWrite("kafka", this.allowWrite);
      const id = this.transactionalId || "e2mcp-hermetic";
      if (toolName === "init_transactions") {
        if (!handle.initTransactions) {
          throw new AdapterError("E_UNSUPPORTED", "Hermetic Kafka handle has no initTransactions", { protocol: "kafka" });
        }
        return { ok: true, hermetic: true, txn: await handle.initTransactions(id) };
      }
      if (toolName === "begin_transaction") {
        if (!handle.beginTransaction) throw new AdapterError("E_UNSUPPORTED", "no beginTransaction", { protocol: "kafka" });
        return { ok: true, hermetic: true, txn: await handle.beginTransaction() };
      }
      if (toolName === "commit_transaction") {
        if (!handle.commitTransaction) throw new AdapterError("E_UNSUPPORTED", "no commitTransaction", { protocol: "kafka" });
        return { ok: true, hermetic: true, txn: await handle.commitTransaction() };
      }
      if (!handle.abortTransaction) throw new AdapterError("E_UNSUPPORTED", "no abortTransaction", { protocol: "kafka" });
      return { ok: true, hermetic: true, txn: await handle.abortTransaction() };
    }
    if (toolName === "group_status") {
      let committed: Record<string, number> = {};
      try {
        committed = (await handle.groupSnapshot?.(this.groupId))?.committed ?? {};
      } catch {
        committed = {};
      }
      const snap = handle.txnSnapshot?.();
      return {
        groupId: this.groupId,
        consumeModel: "one-shot",
        rebalance: handle.caps?.hermeticRebalance ? "hermetic-generation" : "none",
        generation: handle.generationSnapshot?.() ?? 0,
        transactional: snap != null && snap.state !== "empty",
        transactionalId: {
          requested: this.transactionalRequested,
          transactionalId: this.transactionalId || undefined,
          effective: handle.caps?.hermeticTransactions === true && Boolean(handle.txnSnapshot?.()),
          reason: handle.caps?.hermeticTransactions
            ? "Hermetic InitProducerId state machine only. Not a Kafka transaction coordinator / not EOS on a real cluster."
            : "transactional.id is recorded only. This adapter never calls KafkaJS initTransactions / sendOffsets / commitTransaction.",
        },
        idempotent: {
          requested: this.idempotentRequested,
          effective: handle.producerCaps?.idempotent === true,
          reason:
            handle.producerCaps?.idempotent === true
              ? "KafkaJS producer({ idempotent:true, maxInFlightRequests:1 }). Not EOS; no transaction coordinator."
              : "Idempotent producer is off, or the handle does not report producerCaps.idempotent.",
        },
        staticMembership: {
          requested: Boolean(this.groupInstanceId),
          groupInstanceId: this.groupInstanceId || undefined,
          effective: handle.caps?.staticMembership === true && Boolean(this.groupInstanceId),
          reason: handle.caps?.staticMembership
            ? "Hermetic handle keeps group.instance.id in the in-memory group. Live KafkaJS consume_once still disconnects (zombie static member)."
            : "consume_once disconnects after one record. A Kafka group.instance.id would be a zombie static member; this adapter does not honor static membership.",
        },
        committed,
        unsupported: [
          "cooperative-rebalance",
          "incremental-assignment",
          "static-membership",
          "transactions",
          "exactly-once",
          "init_transactions",
        ],
        hermetic: {
          transactions: handle.caps?.hermeticTransactions === true,
          staticMembership: handle.caps?.staticMembership === true,
          txn: snap,
        },
        cluster: {
          eos: false,
          cooperativeRebalance: false,
          requiresBroker: handle.caps?.hermeticTransactions !== true,
        },
        note: "Honest bound: one-shot consume on live KafkaJS. Hermetic handles expose a local txn/static-member/generation stub only. idempotent≠EOS. Real cooperative rebalance / EOS still needs a cluster (still owed).",
      };
    }
    if (toolName === "list_topics") {
      let live: string[] = [];
      try {
        live = await handle.listTopics();
      } catch {
        live = [];
      }
      return { topics: [...new Set([...this.topics, ...live])] };
    }
    if (toolName === "produce") {
      assertCanWrite("kafka", this.allowWrite);
      const topic = (typeof args.topic === "string" && args.topic) || this.defaultTopic;
      if (!topic) throw new Error("Missing topic");
      const value = payloadToString(args.payload);
      const key = typeof args.key === "string" ? args.key : undefined;
      await handle.produce(topic, value, key);
      return { ok: true, topic, bytes: Buffer.byteLength(value) };
    }
    if (toolName === "consume_once") {
      const topic = (typeof args.topic === "string" && args.topic) || this.defaultTopic;
      if (!topic) throw new Error("Missing topic");
      const groupId = typeof args.groupId === "string" && args.groupId.trim() ? args.groupId.trim() : this.groupId;
      return handle.consumeOnce(topic, timeoutMs(args), {
        groupId,
        fromBeginning: true,
        groupInstanceId: this.groupInstanceId || undefined,
      });
    }
    throw new AdapterError("E_UNKNOWN_TOOL", `Unknown Kafka tool "${toolName}"`, { protocol: "kafka" });
  }

  async health(): Promise<AdapterHealth> {
    if (!this.connected) return { ok: false, detail: "not connected" };
    return {
      ok: true,
      detail: `topics=${this.topics.join(",") || "(none)"} groupId=${this.groupId} allowWrite=${this.allowWrite} rebalance=${this.handle?.caps?.hermeticRebalance ? "hermetic-generation" : "none"} transactional=${this.handle?.caps?.hermeticTransactions ? "hermetic" : "false"} idempotent=${this.handle?.producerCaps?.idempotent ? "on" : "off"} staticMembership=${this.handle?.caps?.staticMembership && this.groupInstanceId ? "hermetic" : "off"}`,
    };
  }

  private assertConnected(): void {
    if (!this.connected || !this.handle) {
      throw new AdapterError("E_NOT_CONNECTED", "Kafka adapter is not connected", { protocol: "kafka" });
    }
  }
}
