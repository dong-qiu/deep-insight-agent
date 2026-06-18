"use client";
/** 报告页内追问面板（A4）。spec followup-qa.md。
 *  v1 单轮、同步：提交 → 等回答（~5-10s）→ 追加到列表。
 *  历史问答列表已是"会话"形态，多轮升级时直接演进。 */
import { useState } from "react";
import { Markdown } from "../../../_components/markdown.js";
import type { FollowupQA } from "../../../../lib/types.js";

export function FollowupPanel({
  reportId,
  initial,
  canAsk = true,
}: {
  reportId: string;
  initial: FollowupQA[];
  /** 是否允许提新问（提问烧 relay → 仅 admin；viewer 仍可读历史问答）。 */
  canAsk?: boolean;
}): React.ReactElement {
  const [list, setList] = useState<FollowupQA[]>(initial);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/reports/${reportId}/followup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      const qa = (await res.json()) as FollowupQA;
      setList((prev) => [...prev, qa]);
      setQuestion("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="followup">
      <h2 className="followup-title">追问</h2>
      <p className="muted followup-hint">
        基于本报告已收录、已校验的引用作答；回答中的引用经可达性 + 一致性校验，可点回原文。
      </p>

      {list.map((qa) => {
        const v = qa.validation;
        return (
          <article className="card followup-qa" key={qa.id}>
            <p className="followup-q">
              <strong>问</strong>：{qa.question}
            </p>
            <div className="followup-a">
              <Markdown md={qa.answer_md} anchorPrefix={`cite-fup-${qa.id}-`} />
            </div>
            <p className="muted followup-meta">
              引用 {qa.citations_used.length}
              {v.errored > 0 ? ` · 校验失败·待重试 ${v.errored}` : ""}
              {v.blocked > 0 ? ` · 校验剔除 ${v.blocked}` : ""}
              {qa.cost ? ` · 成本 $${qa.cost.amount.toFixed(4)}` : ""}
            </p>
          </article>
        );
      })}

      {canAsk ? (
        <>
          <form onSubmit={submit} className="followup-form">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="就这份报告继续提问…（最多 500 字）"
              maxLength={500}
              rows={3}
              disabled={busy}
            />
            <button type="submit" disabled={busy || !question.trim()}>
              {busy ? "正在核对报告引用源…" : "提问"}
            </button>
          </form>
          {err ? <p className="followup-err">❌ {err}</p> : null}
        </>
      ) : null}
    </section>
  );
}
