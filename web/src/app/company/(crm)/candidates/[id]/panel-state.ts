import type { PipelineCard, PipelineEvent } from "@/lib/crm/pipeline";
import type { Intro } from "@/lib/crm/types";

/** Стан панелі картки (профіль, W3): картка, останнє знайомство, історія, відповідь останньої дії. */
export interface PanelState {
  card: PipelineCard | null;
  intro: Intro | null;
  history: PipelineEvent[];
  /** Текст для компанії про знайомство, що не дійшло до кандидата (companyIntroNotice, T5), або null. */
  introNotice: string | null;
  /** Яка дія відповіла останньою (add, move, tag_add, note, intro…). */
  op?: string;
  message?: string;
  error?: string;
  fields?: Record<string, string>;
}
