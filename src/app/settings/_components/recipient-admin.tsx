"use client";
/** 邮件分发收件人管理（设置页 · admin only）：列出收件人 + 新增（邮箱/备注）+ 启停 + 删除。
 *  调 /api/admin/recipients（GET 由服务端组件预取，POST/PATCH/DELETE 在此），成功后 router.refresh()。
 *  库里有启用收件人即以库为准；全删/全停则报告邮件回落 env REPORT_EMAIL_TO（兜底）。 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useSettingsStatus } from "./settings-status.js";

interface Row {
  email: string;
  label: string | null;
  enabled: boolean;
  created_at: string;
}

export function RecipientAdmin({ initial }: { initial: Row[] }): React.ReactElement {
  const router = useRouter();
  const notify = useSettingsStatus();
  const [email, setEmail] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /** 调 API；成功返 true（调用方据此决定是否清空表单/收起表单），失败 setErr 并返 false。
   *  okMsg 给定则成功时弹状态条；失败统一弹错误条。 */
  async function call(fn: () => Promise<Response>, okMsg?: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setErr(null);
    try {
      const res = await fn();
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(b.message ?? b.error ?? `HTTP ${res.status}`);
      }
      if (okMsg) notify(okMsg);
      router.refresh();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      notify(`❌ 收件人操作失败：${(e as Error).message}`, "err");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    // currentTarget 必须在 await 前抓——保存成功后收起「+ 添加收件人」外层 details（借鉴 Topic/Source 表单）
    const detailsEl = (e.currentTarget as HTMLFormElement).closest("details");
    const addr = email.trim();
    const ok = await call(() =>
      fetch("/api/admin/recipients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: addr, label: label.trim() }),
      }),
      `✅ 已添加收件人：${addr}`,
    );
    if (ok) {
      setEmail(""); // 仅成功才清空，失败保留输入便于改正重试
      setLabel("");
      if (detailsEl) detailsEl.open = false;
    }
  }

  const toggle = (target: string, enabled: boolean): Promise<boolean> =>
    call(
      () =>
        fetch("/api/admin/recipients", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: target, enabled }),
        }),
      `✅ 已${enabled ? "启用" : "停用"}：${target}`,
    );

  async function remove(target: string): Promise<void> {
    if (!confirm(`从分发名单移除 ${target}？`)) return;
    await call(
      () => fetch(`/api/admin/recipients?email=${encodeURIComponent(target)}`, { method: "DELETE" }),
      `✅ 已移除收件人：${target}`,
    );
  }

  const enabledCount = initial.filter((r) => r.enabled).length;

  return (
    <div>
      {initial.length === 0 ? (
        <p className="muted">
          暂无收件人。下方添加后，每份 Brief/报告推送会发到这些邮箱。
          <strong>名单为空时回落到环境变量 REPORT_EMAIL_TO（兜底）。</strong>
        </p>
      ) : (
        <>
          <p className="muted" style={{ fontSize: ".8rem", margin: "0 0 .5rem" }}>
            报告推送将发往 {enabledCount} 个启用收件人{enabledCount === 0 ? "（全部停用 → 回落 env 兜底）" : ""}。
          </p>
          {initial.map((r) => (
            <div className="card" key={r.email}>
              <strong style={{ opacity: r.enabled ? 1 : 0.5 }}>{r.email}</strong>
              {r.label ? (
                <span className="entity-tag" style={{ marginLeft: ".5rem" }}>{r.label}</span>
              ) : null}
              {r.enabled ? null : (
                <span className="muted" style={{ marginLeft: ".5rem", fontSize: ".8rem" }}>已停用</span>
              )}
              <button
                type="button"
                className="ppt-btn-link"
                style={{ marginLeft: ".5rem" }}
                onClick={() => toggle(r.email, !r.enabled)}
                disabled={busy}
              >
                {r.enabled ? "停用" : "启用"}
              </button>
              <button
                type="button"
                className="ppt-btn-link"
                style={{ marginLeft: ".5rem", color: "#b91c1c" }}
                onClick={() => remove(r.email)}
                disabled={busy}
              >
                删除
              </button>
            </div>
          ))}
        </>
      )}

      <details className="card">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>+ 添加收件人</summary>
        <form onSubmit={add} className="entity-form">
          <label>
            邮箱
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="who@example.com"
              required
            />
          </label>
          <label>
            备注（可选）
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="谁 / 用途，如「产品组」"
            />
          </label>
          <button type="submit" className="ppt-btn" disabled={busy} style={{ alignSelf: "flex-start" }}>
            {busy ? "保存中…" : "保存收件人"}
          </button>
          {err ? <p className="form-err" style={{ marginLeft: 0 }}>❌ {err}</p> : null}
        </form>
      </details>
    </div>
  );
}
