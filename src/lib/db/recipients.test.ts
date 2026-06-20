import { beforeEach, describe, expect, it } from "vitest";
import { type DB, openDb } from "./index.js";
import {
  deleteRecipient,
  listEnabledRecipientEmails,
  listRecipients,
  setRecipientEnabled,
  upsertRecipient,
} from "./recipients.js";

let db: DB;
beforeEach(() => { db = openDb(":memory:"); });

describe("email_recipient 仓储", () => {
  it("新增 → 默认启用、出现在两个 list 里", () => {
    upsertRecipient(db, "a@x.com", "产品组");
    const all = listRecipients(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ email: "a@x.com", label: "产品组", enabled: true });
    expect(listEnabledRecipientEmails(db)).toEqual(["a@x.com"]);
  });

  it("email 规范化小写 + 天然去重（同邮箱大小写不重复，更新 label）", () => {
    upsertRecipient(db, "A@X.com", "v1");
    upsertRecipient(db, "a@x.COM", "v2");
    const all = listRecipients(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ email: "a@x.com", label: "v2" });
  });

  it("停用 → 仍在全量 list、但不在启用名单", () => {
    upsertRecipient(db, "a@x.com");
    expect(setRecipientEnabled(db, "a@x.com", false)).toBe(true);
    expect(listRecipients(db)[0].enabled).toBe(false);
    expect(listEnabledRecipientEmails(db)).toEqual([]);
    // 重新启用
    expect(setRecipientEnabled(db, "a@x.com", true)).toBe(true);
    expect(listEnabledRecipientEmails(db)).toEqual(["a@x.com"]);
  });

  it("重复 upsert 不重置启用态（停用后再 upsert 仍停用）", () => {
    upsertRecipient(db, "a@x.com", "v1");
    setRecipientEnabled(db, "a@x.com", false);
    upsertRecipient(db, "a@x.com", "v2"); // 仅改 label，不碰 enabled
    expect(listRecipients(db)[0]).toMatchObject({ enabled: false, label: "v2" });
  });

  it("删除 → 移出名单；删不存在返 false", () => {
    upsertRecipient(db, "a@x.com");
    expect(deleteRecipient(db, "a@x.com")).toBe(true);
    expect(listRecipients(db)).toHaveLength(0);
    expect(deleteRecipient(db, "nope@x.com")).toBe(false);
  });

  it("启停/删不存在的收件人 → false（不抛）", () => {
    expect(setRecipientEnabled(db, "ghost@x.com", true)).toBe(false);
    expect(deleteRecipient(db, "ghost@x.com")).toBe(false);
  });

  it("启用名单按加入顺序", () => {
    upsertRecipient(db, "first@x.com");
    upsertRecipient(db, "second@x.com");
    expect(listEnabledRecipientEmails(db)).toEqual(["first@x.com", "second@x.com"]);
  });
});
