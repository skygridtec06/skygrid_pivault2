import type { InputHTMLAttributes, ReactNode } from "react";

export function Field({
  label,
  hint,
  ...props
}: { label: string; hint?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </span>
      <input
        {...props}
        className="w-full rounded-xl border border-border bg-input/40 px-4 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-accent focus:ring-2 focus:ring-accent/40"
      />
      {hint ? <span className="mt-1.5 block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function ActionButton({
  children,
  tone = "primary",
  ...props
}: { tone?: "primary" | "accent" | "ghost" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const tones: Record<string, string> = {
    primary: "bg-primary text-primary-foreground hover:brightness-125",
    accent: "bg-accent text-accent-foreground hover:brightness-95",
    ghost: "border border-border bg-transparent text-foreground hover:bg-secondary",
  };
  return (
    <button
      {...props}
      className={`inline-flex min-w-0 max-w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-center text-sm font-semibold leading-tight transition disabled:cursor-not-allowed disabled:opacity-50 sm:px-5 sm:py-3 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
