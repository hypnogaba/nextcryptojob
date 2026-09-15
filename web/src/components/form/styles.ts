// Спільні класи полів форм. Поле друковане: кут 0, лінія 1 px (ConnectKit minimal),
// фокус лінією акценту без розмитого кільця. Кнопки мають свій радіус (ui/button.tsx).

// Раунд 5, п.13(а): фон поля теж міняється у фокусі й коли текст уже є (не лише порожній
// placeholder), щоб було видно, що текст прийнято, навіть коли поле розфокусоване.
const BASE =
  "block w-full rounded-none border border-line-strong bg-surface text-base text-ink transition-colors duration-300 " +
  "placeholder:text-ink-muted hover:border-ink focus-visible:border-brand focus-visible:bg-soft focus-visible:outline-2 " +
  "focus-visible:outline-offset-0 focus-visible:outline-brand not-placeholder-shown:bg-soft aria-invalid:border-destructive " +
  "disabled:cursor-not-allowed disabled:opacity-60";

export const FIELD = `${BASE} h-11 px-3`;

export const TEXTAREA = `${BASE} px-3 py-2.5`;

export const LABEL = "text-sm font-semibold text-ink";
export const HINT = "text-sm text-ink-muted";
export const ERROR = "text-sm text-destructive";
