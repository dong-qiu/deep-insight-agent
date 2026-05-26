"use client";
import { signIn } from "next-auth/react";
import { type FormEvent, useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const res = await signIn("credentials", { email, password, redirect: false });
    setBusy(false);
    if (res?.error) {
      setErr("登录失败：邮箱或密码不正确");
    } else {
      const from = new URLSearchParams(window.location.search).get("from");
      window.location.href = from && from.startsWith("/admin") ? from : "/admin";
    }
  }

  return (
    <section>
      <h2>登录</h2>
      <form onSubmit={onSubmit} style={{ display: "grid", gap: ".5rem", maxWidth: "20rem" }}>
        <input placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          placeholder="密码"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
        {err ? <p className="muted">{err}</p> : null}
      </form>
      <p className="muted">凭据由部署方通过 ADMIN_EMAIL / ADMIN_PASSWORD 环境变量配置。</p>
    </section>
  );
}
