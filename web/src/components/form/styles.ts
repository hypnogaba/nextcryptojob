// Спільні класи полів форм. Поле друковане: кут 0, лінія 1 px (ConnectKit minimal),
// фокус лінією акценту без розмитого кільця. Кнопки мають свій радіус (ui/button.tsx).

const BASE =
  "block w-full rounded-none border border-line-strong bg-surface text-base text-ink " +
  "placeholder:text-ink-muted hover:border-ink focus-visible:border-brand focus-visible:outline-2 " +
  "focus-visible:outline-offset-0 focus-visible:outline-brand aria-invalid:border-destructive " +
  "disabled:cursor-not-allowed disabled:opacity-60";

export const FIELD = `${BASE} h-11 px-3`;

export const TEXTAREA = `${BASE} px-3 py-2.5`;

export const LABEL = "text-sm font-semibold text-ink";
export const HINT = "text-sm text-ink-muted";
export const ERROR = "text-sm text-destructive";
