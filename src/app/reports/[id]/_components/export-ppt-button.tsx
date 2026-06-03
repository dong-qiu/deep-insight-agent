"use client";
/** 报告详情页·导出 PPT 客户端组件（C 阶段）：
 *  两个按钮：A 即时（无 polish）+ B LLM 润色（含 §1 凝练 / §3 启示 / Executive 页）。
 *  - 触发 fetch → 拿 Blob → URL.createObjectURL + 隐式 <a download> 点击下载；
 *  - polish 模式 ~10s + ~$0.07，按钮 disabled + 进度文案防重复点击；
 *  - 错误尝试解析 JSON 给出更明确提示，4xx/5xx 直接显示。 */
import { useState } from "react";

export function ExportPptButton({ reportId }: { reportId: string }): React.ReactElement {
  const [busy, setBusy] = useState<"none" | "plain" | "polish">("none");
  const [err, setErr] = useState<string | null>(null);

  async function download(usePolish: boolean): Promise<void> {
    setBusy(usePolish ? "polish" : "plain");
    setErr(null);
    try {
      const url = `/api/reports/${reportId}/pptx${usePolish ? "?polish=1" : ""}`;
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
  return (
    <span className="export-ppt">
      <button
        type="button"
        className="ppt-btn"
        disabled={disabled}
        onClick={() => download(false)}
        title="A 阶段：确定性骨架，statement 首句 + analyzer 标的 importance_basis；秒级导出、零成本"
      >
        {busy === "plain" ? "生成中…" : "导出 PPT"}
      </button>{" "}
      <button
        type="button"
        className="ppt-btn ppt-btn-secondary"
        disabled={disabled}
        onClick={() => download(true)}
        title="B 阶段：LLM 凝练 §1 + 重写 §3 启示 + Executive Summary 页；~10s · 约 $0.07"
      >
        {busy === "polish" ? "LLM 润色中…（约 10s）" : "LLM 润色导出"}
      </button>
      {err ? <span className="export-ppt-err"> · 失败：{err}</span> : null}
    </span>
  );
}
