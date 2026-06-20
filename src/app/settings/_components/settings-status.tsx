"use client";
/** 设置页共享状态条（admin 体验：写操作成功/失败统一反馈）。
 *  痛点：原各组件写成功只 router.refresh() 静默，页面一长（删视口外的项 / 底部 details 保存）admin 看不到反馈、易重复点击。
 *  方案：一个 aria-live=polite 的固定 toast，由各 client 岛通过 useSettingsStatus().notify() 触发，成功 3s / 失败 6s 自动消失。
 *  零依赖、纯 React state + CSS。Provider 在 page.tsx 包裹设置页；未包裹时 notify 为 no-op（组件可被别处安全复用）。 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type Kind = "ok" | "err";
interface StatusState {
  seq: number;
  text: string;
  kind: Kind;
}

/** 默认 no-op：组件若在 Provider 外渲染（别处复用），调用 notify 不报错、静默降级。 */
const StatusCtx = createContext<(text: string, kind?: Kind) => void>(() => {});

export function useSettingsStatus(): (text: string, kind?: Kind) => void {
  return useContext(StatusCtx);
}

export function SettingsStatusProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [status, setStatus] = useState<StatusState | null>(null);
  const seqRef = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((text: string, kind: Kind = "ok"): void => {
    seqRef.current += 1;
    setStatus({ seq: seqRef.current, text, kind });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(null), kind === "err" ? 6000 : 3000);
  }, []);

  // 卸载时清理挂起的 timer，避免在已卸载组件上 setState
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <StatusCtx.Provider value={notify}>
      {children}
      {/* 单一 live region：外层 aria-live 常驻 DOM，内容增删即播报；内层 toast 不再叠 role=status（避免嵌套 live region） */}
      <div className="settings-status-region" aria-live="polite" aria-atomic="true">
        {status ? (
          <div className={`settings-status settings-status-${status.kind}`} key={status.seq}>
            {status.text}
          </div>
        ) : null}
      </div>
    </StatusCtx.Provider>
  );
}
