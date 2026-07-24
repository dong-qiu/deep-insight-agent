"use client";
/** 管理员方向工作台：分组编辑规划规则；事实、候选和人工状态由独立链路维护。 */
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
export interface DirectionMetric { opportunities: number; stale: number; }

const split = (value: string): string[] => value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
const draftFrom = (direction: TopicDirection): FormState => Object.fromEntries(Object.entries(direction).map(([key, value]) => [key, Array.isArray(value) ? value.join("\n") : value])) as FormState;
const newDraft = (topicId: string): FormState => ({ id: `dir_${topicId.replace(/^t_/, "")}_`, topic_id: topicId, name: "", objective: "", problem_statement: "", horizon: "now", status: "active", in_scope: "", out_of_scope: "", key_questions: "", constraints: "", success_signals: "", match_terms: "", adjacent_terms: "", challenge_terms: "" });
const inputFrom = (form: FormState): TopicDirectionInput => ({ ...form, ...Object.fromEntries(LIST_FIELDS.map(({ key }) => [key, split(form[key])])) }) as unknown as TopicDirectionInput;
const HORIZON: Record<string, string> = { now: "当前", next: "下一阶段", explore: "探索" };

function TextList({ form, set, fields }: { form: FormState; set: <K extends keyof FormState>(key: K, value: FormState[K]) => void; fields: ListField[] }): React.ReactElement {
  return <div className="direction-field-grid">{fields.map((key) => {
    const field = LIST_FIELDS.find((item) => item.key === key)!;
    return <label key={key}>{field.label}<textarea value={form[key]} onChange={(event) => set(key, event.target.value)} placeholder={field.hint} rows={key.includes("terms") ? 3 : 2} /><small className="muted">{field.hint}</small></label>;
  })}</div>;
}

function ChipEditor({ form, set, field, tone }: { form: FormState; set: <K extends keyof FormState>(key: K, value: FormState[K]) => void; field: ListField; tone: "core" | "adjacent" | "challenge" }): React.ReactElement {
  const [pending, setPending] = useState("");
  const definition = LIST_FIELDS.find((item) => item.key === field)!;
  const values = split(form[field]);
  function add(value = pending): void {
    const terms = split(value).filter((item) => !values.includes(item));
    if (terms.length) set(field, [...values, ...terms].join("\n"));
    setPending("");
  }
  return <label className={`rule-editor rule-${tone}`}>
    <span><strong>{definition.label}</strong><small>{definition.hint}</small></span>
    <div className="rule-chip-box">{values.map((value) => <span className="rule-chip" key={value}>{value}<button type="button" aria-label={`移除 ${value}`} onClick={() => set(field, values.filter((item) => item !== value).join("\n"))}>×</button></span>)}<input value={pending} placeholder="输入后回车添加" onChange={(event) => setPending(event.target.value)} onBlur={() => add()} onKeyDown={(event) => { if (event.key === "Enter" || event.key === ",") { event.preventDefault(); add(); } }} /></div>
  </label>;
}

export function DirectionWorkbench({ directions, topics, metrics }: { directions: TopicDirection[]; topics: Topic[]; metrics: Record<string, DirectionMetric> }): React.ReactElement {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(directions[0]?.id ?? "__new__");
  const selected = useMemo(() => directions.find((direction) => direction.id === selectedId), [directions, selectedId]);
  const [form, setForm] = useState<FormState>(() => selected ? draftFrom(selected) : newDraft(topics[0]?.id ?? ""));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [preview, setPreview] = useState<PreviewItem[] | null>(null);
  const [baseline, setBaseline] = useState(() => JSON.stringify(inputFrom(selected ? draftFrom(selected) : newDraft(topics[0]?.id ?? ""))));
  useEffect(() => { const next = selected ? draftFrom(selected) : newDraft(topics[0]?.id ?? ""); setForm(next); setBaseline(JSON.stringify(inputFrom(next))); setPreview(null); setMessage(null); }, [selected, topics]);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const dirty = JSON.stringify(inputFrom(form)) !== baseline;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function selectDirection(id: string): void { if (dirty && !window.confirm("当前方向有未保存修改，确定放弃吗？")) return; setSelectedId(id); }

  async function requestPreview(): Promise<void> {
    if (!selected) { setMessage({ kind: "err", text: "新方向请先保存；保存后可对已有线索重投影。" }); return; }
    setBusy(true); setMessage(null);
    try {
      const res = await fetch("/api/directions/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ direction: inputFrom(form) }) });
      const body = await res.json() as { changes?: PreviewItem[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? "预览失败");
      setPreview(body.changes ?? []);
    } catch (e) { setMessage({ kind: "err", text: (e as Error).message }); } finally { setBusy(false); }
  }
  async function save(reproject = false): Promise<void> {
    setBusy(true); setMessage(null);
    try {
      const direction = inputFrom(form); const isNew = !selected;
      const res = await fetch(isNew ? "/api/directions" : `/api/directions/${selected.id}`, { method: isNew ? "POST" : "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(isNew ? direction : { direction, expected_version: selected.version }) });
      const body = await res.json() as { direction?: TopicDirection; current?: TopicDirection; error?: string };
      if (res.status === 409 && body.current) { setMessage({ kind: "err", text: `版本冲突：服务器已是版本 ${body.current.version}，请刷新后再编辑。` }); return; }
      if (!res.ok || !body.direction) throw new Error(body.error ?? "保存失败");
      if (reproject) {
        const projected = await fetch(`/api/directions/${body.direction.id}/reproject`, { method: "POST" }); const result = await projected.json() as { refreshed?: number; stale?: number; error?: string };
        if (!projected.ok) throw new Error(result.error ?? "保存成功，但重投影失败");
        setPreview(null); setMessage({ kind: "ok", text: `已保存并重投影：刷新 ${result.refreshed ?? 0} 条候选；${result.stale ?? 0} 条仍待复核。` });
      } else setMessage({ kind: "ok", text: "已保存。词表变化仅影响后续线索；历史候选请在确认预览后显式重投影。" });
      setBaseline(JSON.stringify(direction));
      router.refresh();
    } catch (e) { setMessage({ kind: "err", text: (e as Error).message }); } finally { setBusy(false); }
  }

  return <section className="direction-workbench">
    <header className="workbench-heading"><div><p className="eyebrow">管理员规划控制台</p><h3>方向工作台 {dirty ? <span className="unsaved-badge">未保存更改</span> : null}</h3><p className="muted">编辑规划规则不会改写技术事实；候选映射需先预览、再由管理员明确刷新。</p></div><button className="ppt-btn" onClick={() => selectDirection("__new__")}>新建方向</button></header>
    <div className="direction-workbench-grid">
      <aside className="direction-rail" aria-label="技术方向列表"><p className="muted">{directions.length} 个方向</p><ul className="direction-list">{directions.map((direction) => { const metric = metrics[direction.id] ?? { opportunities: 0, stale: 0 }; return <li key={direction.id}><button className={selectedId === direction.id ? "direction-selected" : ""} onClick={() => selectDirection(direction.id)}><strong>{direction.name}</strong><span>{HORIZON[direction.horizon]} · {direction.status}</span><small><b>{metric.opportunities}</b> 个候选{metric.stale ? <em>{metric.stale} 待复核</em> : null}</small></button></li>; })}</ul></aside>
      <form className="direction-form" onSubmit={(event) => { event.preventDefault(); void save(false); }}>
        <header className="direction-form-header"><div><p className="eyebrow">{selected ? `版本 v${selected.version}` : "新方向"}</p><h3>{form.name || "未命名方向"}</h3></div>{selected ? <span className={`direction-status status-${form.status}`}>{form.status}</span> : null}</header>
        <section className="direction-form-section"><h4>战略定义</h4><div className="direction-field-grid direction-basics"><label>方向 ID <input value={form.id} disabled={!!selected} onChange={(event) => set("id", event.target.value)} required /></label><label>主题 <select value={form.topic_id} disabled={!!selected} onChange={(event) => set("topic_id", event.target.value)}>{topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}</select></label><label>方向名称 <input value={form.name} onChange={(event) => set("name", event.target.value)} required /></label><label>时间跨度 <select value={form.horizon} onChange={(event) => set("horizon", event.target.value as FormState["horizon"])}><option value="now">当前</option><option value="next">下一阶段</option><option value="explore">探索</option></select></label><label>状态 <select value={form.status} onChange={(event) => set("status", event.target.value as FormState["status"])}><option value="active">活跃</option><option value="watching">观察</option><option value="retired">停用</option></select></label></div><label className="direction-wide-field">目标 <textarea value={form.objective} onChange={(event) => set("objective", event.target.value)} required rows={2} /></label><label className="direction-wide-field">问题陈述 <textarea value={form.problem_statement} onChange={(event) => set("problem_statement", event.target.value)} required rows={3} /></label></section>
        <details className="direction-form-section" open><summary>范围与研究设计 <span>边界、问题和成功信号</span></summary><TextList form={form} set={set} fields={["in_scope", "out_of_scope", "key_questions", "constraints", "success_signals"]} /></details>
        <details className="direction-form-section" open><summary>映射规则 <span>决定线索进入哪个通道</span></summary><div className="rule-editor-grid"><ChipEditor form={form} set={set} field="match_terms" tone="core" /><ChipEditor form={form} set={set} field="adjacent_terms" tone="adjacent" /><ChipEditor form={form} set={set} field="challenge_terms" tone="challenge" /></div></details>
        {preview ? <section className="direction-preview">{(() => { const added = preview.filter((item) => !item.before && item.after).length; const removed = preview.filter((item) => item.before && !item.after).length; const shifted = preview.length - added - removed; return <><h4>映射影响预览 <span>{preview.length} 条变化</span></h4><div className="impact-summary"><span><b>{added}</b> 新进入</span><span><b>{shifted}</b> 通道迁移</span><span><b>{removed}</b> 不再匹配</span></div>{preview.length ? <ul>{preview.map((item) => <li key={item.lead_id}><strong>{item.title}</strong><span className={`lane-delta lane-${item.before?.lane ?? "none"}`}>{item.before?.lane ?? "未映射"}</span><i>→</i><span className={`lane-delta lane-${item.after?.lane ?? "none"}`}>{item.after?.lane ?? "不再映射"}</span></li>)}</ul> : <p className="muted">近期线索的通道没有变化。</p>}</>; })()}</section> : null}
        <footer className="direction-actions"><div><button className="ppt-btn" type="submit" disabled={busy}>{busy ? "处理中…" : "保存方向"}</button>{selected ? <button className="ppt-btn ppt-btn-secondary" type="button" disabled={busy} onClick={() => void requestPreview()}>预览影响</button> : null}</div>{selected ? <button className="ppt-btn direction-reproject" type="button" disabled={busy} onClick={() => void save(true)}>保存并重投影</button> : null}<small>重投影只刷新映射，不改变人工机会状态。</small></footer>
        {message ? <p className={message.kind === "ok" ? "workbench-message-ok" : "form-err"}>{message.text}</p> : null}
      </form>
    </div>
  </section>;
}
