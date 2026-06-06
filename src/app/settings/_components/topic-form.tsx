"use client";
/** 主题 新建/编辑 表单（B-3）。
 *  mode=create → POST /api/admin/topics
 *  mode=edit → PUT /api/admin/topics/[id]
 *  成功后 router.refresh() 让 /settings 重渲染最新列表。 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Topic } from "../../../lib/types.js";

export function TopicForm({
  mode,
  initial,
  onDone,
}: {
  mode: "create" | "edit";
  initial?: Topic;
  onDone?: () => void;
}): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<Topic>(
    initial ?? {
      id: "", name: "", keywords: [], industry: "ai-swe", language: "zh",
      brief_schedule: "daily", enabled: true,
    },
  );

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const url = mode === "create" ? "/api/admin/topics" : `/api/admin/topics/${initial!.id}`;
      const method = mode === "create" ? "POST" : "PUT";
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const j = (await res.json()) as { message?: string; error?: string };
        throw new Error(j.message ?? j.error ?? `HTTP ${res.status}`);
      }
      onDone?.();
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="entity-form">
      <label>名称 <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
      <label>关键词（逗号分隔） <input
        value={form.keywords.join(", ")}
        onChange={(e) => setForm({ ...form, keywords: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
        placeholder="coding, agent, ide"
      /></label>
      <label>行业 <select value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value as Topic["industry"] })}>
        <option value="ai-swe">ai-swe</option>
        <option value="ai-security">ai-security</option>
      </select></label>
      <label>语言 <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value as Topic["language"] })}>
        <option value="zh">zh</option>
        <option value="en">en</option>
        <option value="mixed">mixed</option>
      </select></label>
      <label>Brief 频率 <select value={form.brief_schedule} onChange={(e) => setForm({ ...form, brief_schedule: e.target.value as Topic["brief_schedule"] })}>
        <option value="daily">daily</option>
        <option value="weekly">weekly</option>
      </select></label>
      <label><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 启用</label>
      <div>
        <button type="submit" className="ppt-btn" disabled={busy}>
          {busy ? "保存中…" : mode === "create" ? "创建" : "保存"}
        </button>
        {err ? <span className="export-ppt-err"> · {err}</span> : null}
      </div>
    </form>
  );
}
