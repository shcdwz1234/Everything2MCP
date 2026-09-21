import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SmtpAdapter,
  listenSmtpLoopback,
  listenSmtpStarttlsLoopback,
  type SmtpMail,
  type SmtpTransporter,
} from "../src/adapters/smtp/index.js";
import { AdapterError } from "../src/runtime/errors.js";

function fakeSmtp(sent: SmtpMail[]): SmtpTransporter {
  return {
    async sendMail(mail) {
      sent.push(mail);
      return { messageId: "<mock@local>" };
    },
    async close() {
      /* noop */
    },
  };
}

describe("SmtpAdapter", () => {
  it("rejects missing host", async () => {
    await assert.rejects(() => new SmtpAdapter("s", async () => fakeSmtp([])).connect({}), /host/);
  });

  it("send_mail via a mock transporter", async () => {
    const sent: SmtpMail[] = [];
    const adapter = new SmtpAdapter("mail", async () => fakeSmtp(sent));
    await adapter.connect({
      host: "127.0.0.1",
      port: 587,
      from: "bot@example.com",
      starttls: true,
      allowWrite: true,
    });
    const names = (await adapter.listTools()).map((t) => t.name);
    assert.deepEqual(names, ["send_mail", "noop"]);
    const ping = (await adapter.invoke("noop", {})) as { ok: boolean };
    assert.equal(ping.ok, true);
    const res = (await adapter.invoke("send_mail", {
      to: "ada@example.com",
      subject: "hello",
      body: "world",
    })) as { ok: boolean; messageId: string; starttls: boolean };
    assert.equal(res.ok, true);
    assert.equal(res.messageId, "<mock@local>");
    assert.equal(res.starttls, true);
    assert.equal(sent[0]?.to, "ada@example.com");
    assert.equal(sent[0]?.subject, "hello");
    assert.equal(sent[0]?.text, "world");
    const health = await adapter.health();
    assert.match(health.detail ?? "", /starttls=true/);
    await adapter.disconnect();
  });

  it("rejects tools before connect and unknown tools", async () => {
    const adapter = new SmtpAdapter("mail", async () => fakeSmtp([]));
    await assert.rejects(() => adapter.listTools(), /not connected/);
    await adapter.connect({ host: "127.0.0.1", allowWrite: true });
    try {
      await assert.rejects(() => adapter.invoke("nope", {}), /Unknown SMTP tool/);
      await assert.rejects(() => adapter.invoke("send_mail", { subject: "x" }), /to/);
      await assert.rejects(
        () => adapter.invoke("send_mail", { to: "ada@example.com", subject: "x" }),
        /body or html/,
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("defaults allowWrite=false and blocks send_mail", async () => {
    const sent: SmtpMail[] = [];
    const adapter = new SmtpAdapter("ro", async () => fakeSmtp(sent));
    await adapter.connect({ host: "127.0.0.1" });
    try {
      await assert.rejects(
        () => adapter.invoke("send_mail", { to: "ada@example.com", subject: "x", body: "y" }),
        /allowWrite/,
      );
      assert.equal(sent.length, 0);
    } finally {
      await adapter.disconnect();
    }
  });

  it("health is not-ok before connect", async () => {
    const adapter = new SmtpAdapter("idle", async () => fakeSmtp([]));
    const health = await adapter.health();
    assert.equal(health.ok, false);
  });

  it("raw SMTP MAIL/RCPT/DATA on loopback; send is not IMAP/POP3", async () => {
    const loop = await listenSmtpLoopback();
    const adapter = new SmtpAdapter("smtp.raw");
    try {
      await adapter.connect({ host: "127.0.0.1", port: loop.port, raw: true, starttls: false, allowWrite: true, timeoutMs: 1500 });
      const ping = (await adapter.invoke("noop", {})) as { ok: boolean };
      assert.equal(ping.ok, true);
      await adapter.invoke("send_mail", { to: "ada@example.com", subject: "hi", body: "there" });
      assert.equal(loop.inbox[0]?.to[0], "ada@example.com");
      assert.equal(loop.inbox[0]?.subject, "hi");
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });

  it("STARTTLS required but not advertised is E_UNSUPPORTED", async () => {
    const loop = await listenSmtpLoopback();
    const adapter = new SmtpAdapter("smtp.notls");
    try {
      await assert.rejects(
        () =>
          adapter.connect({
            host: "127.0.0.1",
            port: loop.port,
            raw: true,
            starttls: true,
            timeoutMs: 1500,
          }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED",
      );
    } finally {
      await loop.close();
    }
  });

  it("STARTTLS-capable banner still accepts plaintext when starttls=false", async () => {
    const loop = await listenSmtpStarttlsLoopback("unused", "unused");
    const adapter = new SmtpAdapter("smtp.offer");
    try {
      await adapter.connect({ host: "127.0.0.1", port: loop.port, raw: true, starttls: false, allowWrite: true, timeoutMs: 1500 });
      await adapter.invoke("send_mail", { to: "ada@example.com", subject: "plain", body: "ok" });
      assert.equal(loop.inbox[0]?.subject, "plain");
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });

  it("allowWrite=false still allows noop on raw loopback", async () => {
    const loop = await listenSmtpLoopback();
    const adapter = new SmtpAdapter("smtp.ro");
    try {
      await adapter.connect({ host: "127.0.0.1", port: loop.port, raw: true, starttls: false });
      await adapter.invoke("noop", {});
      await assert.rejects(
        () => adapter.invoke("send_mail", { to: "a@b", subject: "x", body: "y" }),
        (err: unknown) => err instanceof AdapterError && /allowWrite/.test(String(err)),
      );
    } finally {
      await adapter.disconnect();
      await loop.close();
    }
  });
});
