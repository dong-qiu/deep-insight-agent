"use client";
/** 引用 hover 预览（体验缺口 3.1）：把行内 [N] 从"点了跳底部列表"升级成"悬浮即见引用卡"。
 *
 *  零数据改动——Markdown 已把行内引用渲染成 <sup class="cite-ref"><a href="#cite-N">，引用列表
 *  渲染成 <li id="cite-N">「quote」链接 — 源 · 日期。本组件用事件委托监听全文档的 .cite-ref a，
 *  hover/focus 时按 href 锚点取对应 <li> 的内容克隆进浮层卡。因此报告正文与追问面板（锚前缀
 *  cite-fup-…）都自动覆盖，无需各自接线。
 *
 *  安全：克隆的是本系统自产、React 已转义的受控 DOM，innerHTML 注入无 XSS 风险。
 *  无可达目标（锚点不在本页）则不弹，保持原有点击跳转行为不受影响。 */
import { useEffect, useRef } from "react";

const HIDE_DELAY = 280; // ms：离开引用后留一手，给指针跨过缝隙落到卡上点源链接的时间（review：150ms 偏短）
const GAP = 2; // px：卡与引用的垂直缝隙——越小，指针越不易在缝里悬停触发隐藏

export function CitePreview(): null {
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const card = document.createElement("div");
    card.className = "cite-preview";
    card.setAttribute("role", "tooltip");
    card.hidden = true;
    document.body.appendChild(card);
    cardRef.current = card;

    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelHide = (): void => clearTimeout(hideTimer);
    const scheduleHide = (): void => {
      cancelHide();
      hideTimer = setTimeout(() => {
        card.hidden = true;
      }, HIDE_DELAY);
    };

    const anchorFrom = (t: EventTarget | null): HTMLAnchorElement | null => {
      if (!(t instanceof Element)) return null;
      const a = t.closest(".cite-ref a");
      return a instanceof HTMLAnchorElement ? a : null;
    };

    const show = (a: HTMLAnchorElement): void => {
      const hash = a.getAttribute("href") ?? "";
      if (!hash.startsWith("#")) return;
      const target = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (!target) return; // 锚点不在本页 → 不弹，保留默认跳转
      // 克隆引用列表项，去掉开头的 [N] 序号（卡头已无需重复），余下即 quote 链接 + 源 + 日期。
      const clone = target.cloneNode(true) as HTMLElement;
      clone.querySelector(".cite-num")?.remove();
      card.innerHTML = "";
      const num = document.createElement("div");
      num.className = "cite-preview-num";
      num.textContent = a.textContent ?? ""; // [N]
      const body = document.createElement("div");
      body.className = "cite-preview-body";
      body.innerHTML = clone.innerHTML;
      card.append(num, body);

      // 先显形再量尺寸，避免读到 0×0。默认贴在引用下方左对齐，空间不足则翻到上方 / 夹紧视口。
      card.hidden = false;
      cancelHide();
      const r = a.getBoundingClientRect();
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      const margin = 8;
      let left = r.left;
      if (left + cw + margin > window.innerWidth) left = window.innerWidth - cw - margin;
      if (left < margin) left = margin;
      let top = r.bottom + GAP;
      if (top + ch + margin > window.innerHeight && r.top - ch - GAP > margin) top = r.top - ch - GAP;
      card.style.left = `${Math.round(left)}px`;
      card.style.top = `${Math.round(top)}px`;
    };

    const onOver = (e: MouseEvent): void => {
      const a = anchorFrom(e.target);
      if (a) show(a);
    };
    const onOut = (e: MouseEvent): void => {
      if (anchorFrom(e.target)) scheduleHide();
    };
    const onFocus = (e: FocusEvent): void => {
      const a = anchorFrom(e.target);
      if (a) show(a);
    };
    const onBlur = (e: FocusEvent): void => {
      if (anchorFrom(e.target)) scheduleHide();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") card.hidden = true;
    };

    // 指针在卡上时取消隐藏（便于点源链接）；离开卡再隐藏。滚动直接收起避免错位。
    card.addEventListener("mouseenter", cancelHide);
    card.addEventListener("mouseleave", scheduleHide);
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", scheduleHide, true);

    return () => {
      cancelHide();
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", scheduleHide, true);
      card.remove();
    };
  }, []);

  return null;
}
