"use client";
/** 数据源 新建/编辑 表单（B-3）。 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Source, Topic } from "../../../lib/types.js";

export function SourceForm({
  mode,
  initial,
  topics,
  onDone,
}: {
  mode: "create" | "edit";
  initial?: Source;
  topics: Pick<Topic, "id" | "name">[];
  onDone?: () => void;
}): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<Source>(
    initial ?? {
      id: "", name: "", type: "rss", endpoint: "",
      industry: "ai-swe", topic_ids: [], fetch_interval: "1h",
      backfill: null, enabled: true,
    },
  );

  function toggleTopic(tid: string): void {
    setForm({
      ...form,
      topic_ids: form.topic_ids.includes(tid)
        ? form.topic_ids.filter((t) => t !== tid)
        : [...form.topic_ids, tid],
    });
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    // dogfood feedback：保存成功后关闭外层 <details>（编辑框收回）
    const detailsEl = (e.currentTarget as HTMLFormElement).closest("details");
    setBusy(true); setErr(null);
    try {
      const url = mode === "create" ? "/api/admin/sources" : `/api/admin/sources/${initial!.id}`;
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
      if (detailsEl) detailsEl.open = false;
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
      <label>类型 <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as Source["type"] })}>
        <option value="rss">rss</option>
        <option value="arxiv">arxiv</option>
        <option value="api">api</option>
      </select></label>
      <label>Endpoint <input
        value={form.endpoint}
        onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
        placeholder="https://example.com/feed.xml"
        required
      /></label>
      <label>行业 <select value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value as Source["industry"] })}>
        <option value="ai-swe">ai-swe</option>
        <option value="ai-security">ai-security</option>
      </select></label>
      <label>抓取间隔 <input
        value={form.fetch_interval}
        onChange={(e) => setForm({ ...form, fetch_interval: e.target.value })}
        placeholder="1h / 30m / 1d"
      /></label>
      <fieldset style={{ border: "none", padding: 0 }}>
        <legend className="muted">关联主题</legend>
        {topics.map((t) => (
          <label key={t.id} style={{ display: "inline-block", marginRight: ".5rem" }}>
            <input
              type="checkbox"
              checked={form.topic_ids.includes(t.id)}
              onChange={() => toggleTopic(t.id)}
            /> {t.name}
          </label>
        ))}
      </fieldset>
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
