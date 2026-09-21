import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdapterError } from "../src/runtime/errors.js";
import { LdapAdapter, type LdapHandle } from "../src/adapters/ldap/index.js";

function fakeLdap(): LdapHandle {
  let bound = false;
  const entries = [
    { dn: "cn=ada,dc=example,dc=com", cn: "ada", objectClass: "inetOrgPerson", mail: "ada@example.com" },
    { dn: "cn=bob,dc=example,dc=com", cn: "bob", objectClass: "inetOrgPerson", mail: "bob@example.com" },
    { dn: "cn=cara,dc=example,dc=com", cn: "cara", objectClass: "inetOrgPerson", mail: "cara@example.com" },
  ];
  return {
    async bind(dn, password) {
      if (!dn.includes("=") || password !== "secret") throw new Error("invalid credentials");
      bound = true;
    },
    async saslBind(mechanism, credentials) {
      if (mechanism.toUpperCase() !== "PLAIN") {
        throw new Error(`SASL ${mechanism} unsupported`);
      }
      await this.bind(credentials.dn ?? "", credentials.password ?? "");
    },
    async search(base, filter, _scope, options) {
      if (!bound) throw new Error("not bound");
      let found = entries.filter((e) => e.dn.endsWith(base) || base === "dc=example,dc=com").filter((e) => {
        if (filter === "(objectClass=*)") return true;
        const m = /\((\w+)=([^)]+)\)/.exec(filter);
        if (!m) return true;
        const key = m[1] as keyof (typeof entries)[0];
        return String(e[key]) === m[2];
      });
      if (options?.attributes?.length) {
        found = found.map((e) => {
          const out: Record<string, string> = { dn: e.dn };
          for (const a of options.attributes!) {
            const rec = e as Record<string, string>;
            if (a in rec) out[a] = rec[a]!;
          }
          return out as typeof found[number];
        });
      }
      const pageSize = options?.pageSize;
      const offset = options?.cookie ? Number(options.cookie) : 0;
      if (pageSize) {
        const slice = found.slice(offset, offset + pageSize);
        const next = offset + pageSize;
        return {
          entries: slice,
          pageSize,
          cookie: next < found.length ? String(next) : undefined,
        };
      }
      return { entries: found };
    },
    async compare(dn, attribute, value) {
      const e = entries.find((x) => x.dn === dn) as Record<string, string> | undefined;
      return e?.[attribute] === value;
    },
    async add(dn, attributes) {
      if (!bound) throw new Error("not bound");
      if (entries.some((e) => e.dn === dn)) throw new Error("entry exists");
      const rec: Record<string, string> = { dn };
      for (const [k, v] of Object.entries(attributes)) {
        rec[k] = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
      }
      entries.push(rec as (typeof entries)[number]);
    },
    async modify(dn, changes) {
      if (!bound) throw new Error("not bound");
      const e = entries.find((x) => x.dn === dn) as Record<string, string> | undefined;
      if (!e) throw new Error("no such object");
      for (const c of changes) {
        if (c.operation === "delete") delete e[c.attribute];
        else e[c.attribute] = c.values?.[0] ?? "";
      }
    },
    async del(dn) {
      if (!bound) throw new Error("not bound");
      const i = entries.findIndex((e) => e.dn === dn);
      if (i < 0) throw new Error("no such object");
      entries.splice(i, 1);
    },
    async close() {
      bound = false;
    },
  };
}

describe("LdapAdapter", () => {
  it("rejects missing url", async () => {
    await assert.rejects(() => new LdapAdapter("l", async () => fakeLdap()).connect({}), /url/);
  });

  it("bind / paged search / attribute filter / compare", async () => {
    const adapter = new LdapAdapter("dir", async () => fakeLdap());
    await adapter.connect({ url: "ldap://127.0.0.1:389", base: "dc=example,dc=com", starttls: true });
    await adapter.invoke("bind", { dn: "cn=admin,dc=example,dc=com", password: "secret" });
    const page1 = (await adapter.invoke("search", { pageSize: 2, attributes: ["cn"] })) as {
      count: number;
      cookie?: string;
      entries: Array<{ cn?: string; mail?: string }>;
    };
    assert.equal(page1.count, 2);
    assert.equal(page1.cookie, "2");
    assert.equal(page1.entries[0]?.cn, "ada");
    assert.equal(page1.entries[0]?.mail, undefined);
    const page2 = (await adapter.invoke("search", { pageSize: 2, cookie: page1.cookie, attributes: ["cn"] })) as {
      count: number;
      cookie?: string;
    };
    assert.equal(page2.count, 1);
    assert.equal(page2.cookie, undefined);
    const missing = (await adapter.invoke("search", { attributes: ["cn", "uid"] })) as {
      entries: Array<{ cn?: string; uid?: unknown }>;
    };
    assert.equal(missing.entries[0]?.cn, "ada");
    assert.equal(missing.entries[0]?.uid, null);
    const cmp = (await adapter.invoke("compare", {
      dn: "cn=ada,dc=example,dc=com",
      attribute: "mail",
      value: "ada@example.com",
    })) as { matched: boolean };
    assert.equal(cmp.matched, true);
    const health = await adapter.health();
    assert.match(health.detail ?? "", /starttls=true/);
    await adapter.disconnect();
  });

  it("sasl_bind PLAIN maps to simple bind; other mechanisms are E_UNSUPPORTED", async () => {
    const adapter = new LdapAdapter("dir", async () => fakeLdap());
    await adapter.connect({ url: "ldap://127.0.0.1:389", base: "dc=example,dc=com" });
    try {
      const names = (await adapter.listTools()).map((t) => t.name);
      assert.ok(names.includes("sasl_bind"));
      const ok = (await adapter.invoke("sasl_bind", {
        mechanism: "PLAIN",
        dn: "cn=admin,dc=example,dc=com",
        password: "secret",
      })) as { bound: boolean; mechanism: string };
      assert.equal(ok.bound, true);
      assert.equal(ok.mechanism, "PLAIN");
      await assert.rejects(
        () => adapter.invoke("sasl_bind", { mechanism: "GSSAPI", dn: "cn=admin,dc=example,dc=com", password: "secret" }),
        (err: unknown) => err instanceof AdapterError && err.code === "E_UNSUPPORTED" && /GSSAPI/i.test(err.message),
      );
    } finally {
      await adapter.disconnect();
    }
  });

  it("rejects invalid bind credentials", async () => {
    const adapter = new LdapAdapter("dir", async () => fakeLdap());
    await adapter.connect({ url: "ldap://127.0.0.1:389", base: "dc=example,dc=com" });
    await assert.rejects(() => adapter.invoke("bind", { dn: "cn=admin,dc=example,dc=com", password: "wrong" }));
    await adapter.disconnect();
  });

  it("records tls=true (ldaps) in health", async () => {
    const adapter = new LdapAdapter("tls", async () => fakeLdap());
    await adapter.connect({ url: "ldap://127.0.0.1:389", tls: true, base: "dc=example,dc=com" });
    const health = await adapter.health();
    assert.match(health.detail ?? "", /tls=true/);
    await adapter.disconnect();
  });

  it("add/modify/delete require allowWrite and mutate the hermetic directory", async () => {
    const ro = new LdapAdapter("ro", async () => fakeLdap());
    await ro.connect({ url: "ldap://127.0.0.1:389", base: "dc=example,dc=com" });
    try {
      await ro.invoke("bind", { dn: "cn=admin,dc=example,dc=com", password: "secret" });
      await assert.rejects(
        () => ro.invoke("add", { dn: "cn=zoe,dc=example,dc=com", attributes: { cn: "zoe" } }),
        /allowWrite/,
      );
      await assert.rejects(
        () =>
          ro.invoke("modify", {
            dn: "cn=ada,dc=example,dc=com",
            changes: [{ operation: "replace", attribute: "mail", values: ["n@e.com"] }],
          }),
        /allowWrite/,
      );
      await assert.rejects(() => ro.invoke("delete", { dn: "cn=bob,dc=example,dc=com" }), /allowWrite/);
    } finally {
      await ro.disconnect();
    }

    const rw = new LdapAdapter("rw", async () => fakeLdap());
    await rw.connect({ url: "ldap://127.0.0.1:389", base: "dc=example,dc=com", allowWrite: true });
    try {
      await rw.invoke("bind", { dn: "cn=admin,dc=example,dc=com", password: "secret" });
      const added = (await rw.invoke("add", {
        dn: "cn=zoe,dc=example,dc=com",
        attributes: { cn: "zoe", mail: "zoe@example.com", objectClass: "inetOrgPerson" },
      })) as { ok: boolean; dn: string };
      assert.equal(added.ok, true);
      const found = (await rw.invoke("search", { filter: "(cn=zoe)", attributes: ["mail"] })) as {
        count: number;
        entries: Array<{ mail?: string }>;
      };
      assert.equal(found.count, 1);
      assert.equal(found.entries[0]?.mail, "zoe@example.com");
      await rw.invoke("modify", {
        dn: "cn=zoe,dc=example,dc=com",
        changes: [{ operation: "replace", attribute: "mail", values: ["z@example.com"] }],
      });
      const cmp = (await rw.invoke("compare", {
        dn: "cn=zoe,dc=example,dc=com",
        attribute: "mail",
        value: "z@example.com",
      })) as { matched: boolean };
      assert.equal(cmp.matched, true);
      await rw.invoke("delete", { dn: "cn=zoe,dc=example,dc=com" });
      const gone = (await rw.invoke("search", { filter: "(cn=zoe)" })) as { count: number };
      assert.equal(gone.count, 0);
    } finally {
      await rw.disconnect();
    }
  });

  it("rejects tools before connect and unknown tools", async () => {
    const adapter = new LdapAdapter("dir", async () => fakeLdap());
    await assert.rejects(() => adapter.listTools(), /not connected/);
    await adapter.connect({ url: "ldap://127.0.0.1:389", base: "dc=example,dc=com" });
    try {
      await assert.rejects(() => adapter.invoke("nope", {}), /Unknown LDAP tool/);
    } finally {
      await adapter.disconnect();
    }
  });
});
