"use client";
/** 管理员方向工作台：先预览再保存/重投影，表单只维护规划规则而不触碰事实层。 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Topic, TopicDirection, TopicDirectionInput } from "../../../lib/types.js";

type ListField = "in_scope" | "out_of_scope" | "key_questions" | "constraints" | "success_signals" | "match_terms" | "adjacent_terms" | "challenge_terms";
const LIST_FIELDS: Array<{ key: ListField; label: string; hint: string }> = [
  { key: "in_scope", label: "纳入范围", hint: "逗号或换行分隔" }, { key: "out_of_scope", label: "排除范围", hint: "逗号或换行分隔" },
  { key: "key_questions", label: "关键问题", hint: "每行一个问题" }, { key: "constraints", label: "约束", hint: "每行一个约束" },
  { key: "success_signals", label: "成功信号", hint: "每行一个可观察信号" },
  { key: "match_terms", label: "核心匹配词", hint: "命中后进入核心方向" }, { key: "adjacent_terms", label: "相邻匹配词", hint: "命中后进入相邻机会" }, { key: "challenge_terms", label: "反证词", hint: "优先命中，进入反证/风险" },
];
type FormState = Omit<TopicDirectionInput, ListField> & Record<ListField, string>;
type PreviewItem = { lead_id: string; title: string; before: { lane: string } | null; after: { lane: string } | null };

const split = (value: string): string[] => value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
const draftFrom = (direction: TopicDirection): FormState => Object.fromEntries(Object.entries(direction).map(([key, value]) => [key, Array.isArray(value) ? value.join("\n") : value])) as FormState;
const newDraft = (topicId: string): FormState => ({
  id: `dir_${topicId.replace(/^t_/, "")}_`, topic_id: topicId, name: "", objective: "", problem_statement: "", horizon: "now", status: "active",
  in_scope: "", out_of_scope: "", key_questions: "", constraints: "", success_signals: "", match_terms: "", adjacent_terms: "", challenge_terms: "",
});
const inputFrom = (form: FormState): TopicDirectionInput => ({ ...form, ...Object.fromEntries(LIST_FIELDS.map(({ key }) => [key, split(form[key])])) }) as unknown as TopicDirectionInput;

export function DirectionWorkbench({ directions, topics }: { directions: TopicDirection[]; topics: Topic[] }): React.ReactElement {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(directions[0]?.id ?? "__new__");
  const selected = useMemo(() => directions.find((direction) => direction.id === selectedId), [directions, selectedId]);
  const [form, setForm] = useState<FormState>(() => selected ? draftFrom(selected) : newDraft(topics[0]?.id ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewItem[] | null>(null);
  useEffect(() => { setForm(selected ? draftFrom(selected) : newDraft(topics[0]?.id ?? "")); setPreview(null); setError(null); }, [selected, topics]);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));

  async function requestPreview(): Promise<void> {
    if (!selected) { setError("新方向请先保存；保存后可对已有线索重投影。"); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/directions/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ direction: inputFrom(form) }) });
      const body = await res.json() as { changes?: PreviewItem[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? "预览失败");
      setPreview(body.changes ?? []);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function save(reproject = false): Promise<void> {
    setBusy(true); setError(null);
    try {
      const direction = inputFrom(form);
      const isNew = !selected;
      const res = await fetch(isNew ? "/api/directions" : `/api/directions/${selected.id}`, {
        method: isNew ? "POST" : "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify(isNew ? direction : { direction, expected_version: selected.version }),
      });
      const body = await res.json() as { direction?: TopicDirection; current?: TopicDirection; error?: string };
      if (res.status === 409 && body.current) { setError(`版本冲突：服务器已是版本 ${body.current.version}，请刷新后再编辑。`); return; }
      if (!res.ok || !body.direction) throw new Error(body.error ?? "保存失败");
      if (reproject) {
        const projected = await fetch(`/api/directions/${body.direction.id}/reproject`, { method: "POST" });
        const result = await projected.json() as { refreshed?: number; stale?: number; error?: string };
        if (!projected.ok) throw new Error(result.error ?? "保存成功，但重投影失败");
        setPreview(null); setError(`已保存并重投影：刷新 ${result.refreshed ?? 0} 条候选；其余 ${result.stale ?? 0} 条旧映射待复核。`);
      } else setError("已保存。词表变化仅影响后续线索；如需处理既有候选，请使用“保存并重投影”。");
      router.refresh();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return <section className="card direction-workbench">
    <h3>方向工作台</h3><p className="muted">保存战略档案不会改写技术事实；词表变更会将相关候选标为“待复核”，重投影须由管理员显式确认。</p>
    <div className="direction-workbench-grid">
      <aside><button className="ppt-btn ppt-btn-secondary" onClick={() => setSelectedId("__new__")}>新建方向</button><ul className="direction-list">{directions.map((direction) => <li key={direction.id}><button className={selectedId === direction.id ? "direction-selected" : ""} onClick={() => setSelectedId(direction.id)}>{direction.name}<small>{direction.status} · v{direction.version}</small></button></li>)}</ul></aside>
      <form className="entity-form" onSubmit={(event) => { event.preventDefault(); void save(false); }}>
        <label>方向 ID <input value={form.id} disabled={!!selected} onChange={(event) => set("id", event.target.value)} required /></label>
        <label>主题 <select value={form.topic_id} disabled={!!selected} onChange={(event) => set("topic_id", event.target.value)}>{topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}</select></label>
        <label>名称 <input value={form.name} onChange={(event) => set("name", event.target.value)} required /></label>
        <label>目标 <textarea value={form.objective} onChange={(event) => set("objective", event.target.value)} required /></label>
        <label>问题陈述 <textarea value={form.problem_statement} onChange={(event) => set("problem_statement", event.target.value)} required /></label>
        <label>时间跨度 <select value={form.horizon} onChange={(event) => set("horizon", event.target.value as FormState["horizon"])}><option value="now">当前</option><option value="next">下一阶段</option><option value="explore">探索</option></select></label>
        <label>状态 <select value={form.status} onChange={(event) => set("status", event.target.value as FormState["status"])}><option value="active">活跃</option><option value="watching">观察</option><option value="retired">停用</option></select></label>
        {LIST_FIELDS.map(({ key, label, hint }) => <label key={key} style={{ alignItems: "flex-start" }}>{label}<span style={{ flex: 1 }}><textarea value={form[key]} onChange={(event) => set(key, event.target.value)} placeholder={hint} rows={key.includes("terms") ? 3 : 2} /><small className="muted">{hint}</small></span></label>)}
        <div className="direction-actions"><button className="ppt-btn" type="submit" disabled={busy}>{busy ? "处理中…" : "保存方向"}</button>{selected ? <><button className="ppt-btn ppt-btn-secondary" type="button" disabled={busy} onClick={() => void requestPreview()}>预览影响</button><button className="ppt-btn ppt-btn-secondary" type="button" disabled={busy} onClick={() => void save(true)}>保存并重投影</button></> : null}</div>
        {error ? <p className={error.startsWith("已") ? "muted" : "form-err"}>{error}</p> : null}
      </form>
    </div>
    {preview ? <details open className="direction-preview"><summary>近期线索映射变化（{preview.length}）</summary>{preview.length ? <ul>{preview.map((item) => <li key={item.lead_id}><strong>{item.title}</strong>：{item.before?.lane ?? "未映射"} → {item.after?.lane ?? "不再映射"}</li>)}</ul> : <p className="muted">近期线索的通道没有变化。</p>}</details> : null}
  </section>;
}
