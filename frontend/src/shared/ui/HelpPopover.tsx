import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import "./helpPopover.css";

/** Nonmodal help: hover/focus to read, click to keep open, including on touch. */
export function HelpPopover({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useI18n();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinned = useRef(false);
  const dismissed = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const cancelClose = () => { clearTimeout(timer.current); };
  const close = (restore = false) => {
    cancelClose(); pinned.current = false; setOpen(false);
    if (restore) { dismissed.current = true; trigger.current?.focus(); }
  };
  const leave = () => {
    cancelClose();
    timer.current = setTimeout(() => {
      if (!pinned.current && !panel.current?.contains(document.activeElement) && document.activeElement !== trigger.current) setOpen(false);
    }, 160);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !panel.current) return;
      if (trigger.current.closest("[hidden]")) { close(); return; }
      const anchor = trigger.current.getBoundingClientRect();
      const bounds = panel.current.getBoundingClientRect();
      const left = Math.max(12, Math.min(anchor.left, window.innerWidth - bounds.width - 12));
      const below = anchor.bottom + 8;
      const top = Math.max(12, Math.min(below + bounds.height > window.innerHeight - 12 ? anchor.top - bounds.height - 8 : below, window.innerHeight - bounds.height - 12));
      setPosition({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, children, label]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key, true); };
  }, [open]);
  return <>
    <button ref={trigger} type="button" className="px-help" aria-label={t(`Help: ${label}`, `帮助：${label}`)} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
      onMouseEnter={() => { cancelClose(); if (!dismissed.current) setOpen(true); }} onMouseLeave={() => { dismissed.current = false; leave(); }}
      onFocus={() => { if (!dismissed.current) setOpen(true); }}
      onBlur={() => { dismissed.current = false; leave(); }}
      onClick={event => { event.stopPropagation(); cancelClose(); dismissed.current = false; if (pinned.current) close(true); else { pinned.current = true; setOpen(true); requestAnimationFrame(() => { if (pinned.current) panel.current?.focus(); }); } }}
    >?</button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label={label} tabIndex={-1} className="px-help-panel" style={position}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
      onMouseEnter={cancelClose} onMouseLeave={leave} onFocus={cancelClose}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) close(); }}>
      <div className="px-help-panel__header"><strong>{label}</strong><button type="button" className="px-help-panel__close" aria-label={t("Close help", "关闭帮助")} onClick={() => close(true)}>×</button></div>
      <div className="px-help-panel__body">{children}</div>
    </div>, document.body)}
  </>;
}
