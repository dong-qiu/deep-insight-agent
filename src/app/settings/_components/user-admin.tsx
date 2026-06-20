"use client";
/** 用户管理（设置页 · admin only）：列出受邀账号 + 新增（邮箱/密码/角色）+ 删除。
 *  调 /api/admin/users（GET 由服务端组件预取，POST/DELETE 在此），成功后 router.refresh() 刷新列表。
 *  bootstrap admin（env ADMIN_*）不在此列、不可删。 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useSettingsStatus } from "./settings-status.js";

interface Row {
  email: string;
  role: "admin" | "viewer";
  name: string | null;
  created_at: string;
}

export function UserAdmin({ initial }: { initial: Row[] }): React.ReactElement {
  const router = useRouter();
  const notify = useSettingsStatus();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    // currentTarget 须在 await 前抓——成功后收起「+ 添加账号」外层 details
    const detailsEl = (e.currentTarget as HTMLFormElement).closest("details");
    const addr = email.trim();
    setBusy(true);
    setErr(null);
    try {
      // 受邀账号一律 viewer（只读）；唯一 admin 是内置环境变量账号。
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: addr, password }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(b.message ?? b.error ?? `HTTP ${res.status}`);
      }
      setEmail("");
      setPassword("");
      if (detailsEl) detailsEl.open = false;
      notify(`✅ 已添加账号：${addr}（viewer）`);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      notify(`❌ 添加账号失败：${(e as Error).message}`, "err");
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: string): Promise<void> {
    if (busy || !confirm(`删除账号 ${target}？\n对方将立即无法登录（如只是临时禁用，建议保留账号）。`)) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/users?email=${encodeURIComponent(target)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`删除失败 HTTP ${res.status}`);
      notify(`✅ 已删除账号：${target}`);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      notify(`❌ 删除账号失败：${(e as Error).message}`, "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {initial.length === 0 ? (
        <p className="muted">暂无受邀账号。下方添加后，对方即可用该邮箱+密码登录（viewer 只读）。</p>
      ) : (
        initial.map((u) => (
          <div className="card" key={u.email}>
            <strong>{u.email}</strong>
            <span className="entity-tag" style={{ marginLeft: ".5rem" }}>{u.role}</span>
            <button
              type="button"
              className="ppt-btn-link"
              style={{ marginLeft: ".5rem", color: "#b91c1c" }}
              onClick={() => remove(u.email)}
              disabled={busy}
            >
              删除
            </button>
          </div>
        ))
      )}

      <details className="card">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>+ 添加账号</summary>
        <form onSubmit={add} className="entity-form">
          <label>
            邮箱
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="who@example.com" required />
          </label>
          <label>
            密码
            <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 6 位（明文设定，发给对方）" minLength={6} required />
          </label>
          <p className="muted" style={{ fontSize: ".8rem", margin: 0 }}>账号为 viewer（只读）；唯一管理员是内置账号。</p>
          <button type="submit" className="ppt-btn" disabled={busy} style={{ alignSelf: "flex-start" }}>
            {busy ? "保存中…" : "保存账号"}
          </button>
          {err ? <p className="form-err" style={{ marginLeft: 0 }}>❌ {err}</p> : null}
        </form>
      </details>
    </div>
  );
}
