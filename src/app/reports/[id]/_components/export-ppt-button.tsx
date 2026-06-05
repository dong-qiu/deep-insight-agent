"use client";
/** 报告详情页·导出 PPT 客户端组件（C 阶段 + D 阶段状态外露）：
 *  两个主按钮：A 即时（无 polish）+ B LLM 润色（含 §1 凝练 / §3 启示 / Executive 页）。
 *  - 触发 fetch → 拿 Blob → URL.createObjectURL + 隐式 <a download> 点击下载；
 *  - polish 模式 ~10s + ~$0.07，按钮 disabled + 进度文案防重复点击；
 *  - 错误尝试解析 JSON 给出更明确提示，4xx/5xx 直接显示；
 *  - D 阶段：fetch 完读响应头 → 显示 cache/coverage/cost 状态行；
 *    polish 结果不完整（partial / no-executive）时旁边出"重新生成"链接（&refresh=1 补漏）。 */
import { useState } from "react";
import {
  describePolishMeta,
  parsePolishMeta,
  shouldOfferRefresh,
  type PolishMeta,
} from "./polish-meta.js";

export function ExportPptButton({ reportId }: { reportId: string }): React.ReactElement {
  const [busy, setBusy] = useState<"none" | "plain" | "polish" | "refresh">("none");
  const [err, setErr] = useState<string | null>(null);
  const [meta, setMeta] = useState<PolishMeta | null>(null);

  async function download(opts: { polish: boolean; refresh?: boolean }): Promise<void> {
    setBusy(opts.refresh ? "refresh" : opts.polish ? "polish" : "plain");
    setErr(null);
    try {
      const qs = opts.polish
        ? opts.refresh
          ? "?polish=1&refresh=1"
          : "?polish=1"
        : "";
      const url = `/api/reports/${reportId}/pptx${qs}`;
      const res = await fetch(url);
      if (!res.ok) {
        let msg = `${res.status} ${res.statusText}`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j.error) msg = `${res.status} · ${j.error}`;
        } catch {
          /* 非 JSON 响应——保持 statusText */
        }
        throw new Error(msg);
      }
      // 解析 polish 元数据（A 路径会返 null，不显示状态行）
      setMeta(parsePolishMeta(res.headers));
      // 文件名从 Content-Disposition 提取；失败用兜底名
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m = cd.match(/filename\*=UTF-8''([^;]+)/);
      const fileName = m ? decodeURIComponent(m[1]) : `report-${reportId}.pptx`;
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("none");
    }
  }

  const disabled = busy !== "none";
  const desc = describePolishMeta(meta);
  const offerRefresh = shouldOfferRefresh(meta);

  return (
    <span className="export-ppt">
      <button
        type="button"
        className="ppt-btn"
        disabled={disabled}
        onClick={() => download({ polish: false })}
        title="A 阶段：确定性骨架，statement 首句 + analyzer 标的 importance_basis；秒级导出、零成本"
      >
        {busy === "plain" ? "生成中…" : "导出 PPT"}
      </button>{" "}
      <button
        type="button"
        className="ppt-btn ppt-btn-secondary"
        disabled={disabled}
        onClick={() => download({ polish: true })}
        title="B 阶段：LLM 凝练 §1 + 重写 §3 启示 + Executive Summary 页；首次 ~10–30s · 约 $0.05–0.25；命中缓存秒级返"
      >
        {busy === "polish" ? "LLM 润色中…（最多 30s）" : "LLM 润色导出"}
      </button>
      {desc ? (
        <span className="export-ppt-meta" style={{ marginLeft: "0.5rem" }}>
          · {desc}
          {offerRefresh ? (
            <>
              {" · "}
              <button
                type="button"
                className="ppt-btn-link"
                disabled={disabled}
                onClick={() => download({ polish: true, refresh: true })}
                title="忽略缓存重跑 LLM；新成功覆盖、失败保留旧；中转站偶发截断 → 多次刷新逐步补齐"
              >
                {busy === "refresh" ? "重生成中…" : "重新生成"}
              </button>
            </>
          ) : null}
        </span>
      ) : null}
      {err ? <span className="export-ppt-err"> · 失败：{err}</span> : null}
    </span>
  );
}
