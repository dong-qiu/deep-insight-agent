"use client";
/** 主题 新建/编辑 表单（B-3）。
 *  mode=create → POST /api/admin/topics
 *  mode=edit → PUT /api/admin/topics/[id]
 *  成功后 router.refresh() 让 /settings 重渲染最新列表。
 *
 *  dogfood 发现的 bug（2026-06-06）：keywords input 之前 onChange 即时 split+trim+filter，
 *  导致用户按空格时空格被立刻吃掉、光标回退、"无法输入空格"假象。
 *  修复：input 用独立 raw string state，submit 时才 split+trim+filter；
 *  显示同步走 raw（避免 round-trip 截断中文/空格）。 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ARCHETYPE_VALUES } from "../../../lib/topics/archetype.js";
import { DOMAIN_VALUES, domainFacet } from "../../../lib/topics/facets.js";
import type { Topic } from "../../../lib/types.js";
import { useSettingsStatus } from "./settings-status.js";

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
  const notify = useSettingsStatus();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<Omit<Topic, "keywords">>(
    initial ? { ...initial, archetype: initial.archetype ?? "deep_vertical", facets: initial.facets ?? [] } : {
      id: "", name: "", industry: "ai-swe", language: "zh",
      brief_schedule: "daily", enabled: true, archetype: "deep_vertical", facets: [],
    },
  );
  const facets = form.facets ?? [];
  function toggleFacet(f: string): void {
    setForm({ ...form, facets: facets.includes(f) ? facets.filter((x) => x !== f) : [...facets, f] });
  }
  // keywords 单独 raw string state，避免 round-trip trim 吃空格 / 中文
  const [keywordsRaw, setKeywordsRaw] = useState((initial?.keywords ?? []).join(", "));

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    // 抓取 form 的祖先 <details>——保存成功后关闭它（dogfood feedback：保存后编辑框该收回）
    // currentTarget 必须在 await 前抓，await 之后会变 null
    const detailsEl = (e.currentTarget as HTMLFormElement).closest("details");
    setBusy(true); setErr(null);
    try {
      // 提交时把 raw 切成数组——接受 `,` 或换行作为分隔，用户可用 textarea 多行
      // 或粘贴单行逗号串都行（dogfood feedback：单行 input 难看清，改 textarea）
      const keywords = keywordsRaw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      const url = mode === "create" ? "/api/admin/topics" : `/api/admin/topics/${initial!.id}`;
      const method = mode === "create" ? "POST" : "PUT";
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, keywords }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { message?: string; error?: string };
        throw new Error(j.message ?? j.error ?? `HTTP ${res.status}`);
      }
      onDone?.();
      // 保存成功 → 关闭外层 <details>（编辑框收回）；refresh 让 server 拉新数据
      if (detailsEl) detailsEl.open = false;
      notify(`✅ 主题已${mode === "create" ? "创建" : "保存"}：${form.name}`);
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
      notify(`❌ 主题保存失败：${(e as Error).message}`, "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="entity-form">
      <label>名称 <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
      <label style={{ alignItems: "flex-start" }}>关键词（逗号或换行分隔） <textarea
        value={keywordsRaw}
        onChange={(e) => setKeywordsRaw(e.target.value)}
        placeholder={"coding agent\nautonomous software engineering\nRAG 检索增强\n…"}
        rows={4}
        style={{ flex: 1, fontFamily: "inherit", resize: "vertical", minHeight: "5rem" }}
      /></label>
      <label>行业 <select value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value as Topic["industry"] })}>
        <option value="ai-swe">ai-swe</option>
        <option value="ai-security">ai-security</option>
      </select></label>
      <label>原型 <select value={form.archetype} onChange={(e) => setForm({ ...form, archetype: e.target.value as Topic["archetype"] })}>
        {ARCHETYPE_VALUES.map((a) => <option key={a} value={a}>{a}</option>)}
      </select></label>
      <label style={{ alignItems: "flex-start" }}>分面（domain）<span style={{ display: "flex", gap: ".75rem", flexWrap: "wrap" }}>
        {DOMAIN_VALUES.map((d) => {
          const f = domainFacet(d);
          return <label key={d} style={{ fontWeight: "normal" }}>
            <input type="checkbox" checked={facets.includes(f)} onChange={() => toggleFacet(f)} /> {d}
          </label>;
        })}
      </span></label>
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
        {err ? <span className="form-err"> · {err}</span> : null}
      </div>
    </form>
  );
}
