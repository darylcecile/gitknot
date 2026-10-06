import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";

export function Popover({ label, trigger, children, className = "", onOpenChange, id: providedId }: {
  label: string; trigger: ReactNode; children: (close: (restoreFocus?: boolean) => void) => ReactNode;
  className?: string; onOpenChange?: (open: boolean) => void; id?: string;
}) {
  const generated = useId();
  const id = providedId || generated;
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !panel.current) return;
    const position = () => {
      if (!anchor.current || !panel.current) return;
      const bounds = anchor.current.getBoundingClientRect();
      const width = Math.min(Math.max(bounds.width, className.includes("action-popover") ? 220 : 320), window.innerWidth - 24);
      panel.current.style.width = `${width}px`;
      const availableBelow = window.innerHeight - bounds.bottom - 12;
      const above = availableBelow < Math.min(panel.current.scrollHeight, 260) && bounds.top > availableBelow;
      const height = Math.max(100, above ? bounds.top - 20 : availableBelow);
      panel.current.style.maxHeight = `${height}px`;
      panel.current.style.left = `${Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12))}px`;
      panel.current.style.top = above ? "auto" : `${bounds.bottom + 6}px`;
      panel.current.style.bottom = above ? `${window.innerHeight - bounds.top + 6}px` : "auto";
      panel.current.style.transformOrigin = above ? "bottom left" : "top left";
    };
    position();
    if (matchMedia("(pointer: fine)").matches) panel.current.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open, className]);
  const close = (restoreFocus = true) => {
    panel.current?.hidePopover();
    if (restoreFocus) anchor.current?.focus();
  };
  return <>
    <button type="button" ref={anchor} className={`popover-trigger ${className}`} popoverTarget={id}
      aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={id}>{trigger}</button>
    <div id={id} ref={panel} popover="auto" className={`popover-panel ${className}`} role="dialog" aria-label={label}
      onToggle={event => { const next = (event.nativeEvent as ToggleEvent).newState === "open"; setOpen(next); onOpenChange?.(next); }}>
      {children(close)}
    </div>
  </>;
}

export function ActionMenu({ children, label = "More actions" }: { children: ReactNode; label?: string }) {
  return <Popover label={label} className="action-popover" trigger={<Ellipsis size={18} aria-hidden="true" />}>
    {close => <div className="action-menu" onClick={event => {
      if ((event.target as HTMLElement).closest("button, a")) close(false);
    }}>{children}</div>}
  </Popover>;
}
