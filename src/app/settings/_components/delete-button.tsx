"use client";
/** 删除按钮（B-3 共用）：confirm 一次 + DELETE → 错误回显 + router.refresh。
 *  FK 违例时后端返 409 + 中文文案，提示用户改 enabled=false。 */
import { useRouter } from "next/navigation";
import { useState } from "react";

export function DeleteButton({
  entity,
  id,
  name,
}: {
  entity: "topics" | "sources";
  id: string;
  name: string;
}): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onDelete(): Promise<void> {
    if (!confirm(`确认删除 "${name}"（${id}）？\n如被引用会自动拦截（建议改"启用=否"代替删除）。`)) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/admin/${entity}/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = (await res.json()) as { message?: string; error?: string };
        throw new Error(j.message ?? j.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ marginLeft: ".5rem" }}>
      <button
        type="button"
        className="ppt-btn-link"
        onClick={onDelete}
        disabled={busy}
        style={{ color: "#b91c1c" }}
      >
        {busy ? "删除中…" : "删除"}
      </button>
      {err ? <span className="export-ppt-err" style={{ marginLeft: ".5rem" }}>{err}</span> : null}
    </span>
  );
}
