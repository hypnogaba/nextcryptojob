/**
 * Точки, де налаштування й видалення акаунта кажуть CRM про зміну.
 *
 * TODO(merge з доріжкою CRM): CRM додає у web/src/lib/crm/visibility.ts
 * onVisibilityChanged(userId, visible) і beforeCandidateErased(userId)
 * (специфікація CRM, розділи 11 і 13). Під час злиття controller замінює тіла
 * нижче викликами цих функцій. Доти це заглушки: у 0003_crm ще немає таблиць
 * на продакшені, тож і повідомляти нікого.
 */

/**
 * Після зміни видимості (уже записаної в базу): CRM пише visibility_lost або
 * visibility_restored у картки воронки цієї людини.
 */
export async function notifyCrmVisibility(userId: string, visible: boolean): Promise<void> {
  void userId;
  void visible;
}

/**
 * Перед видаленням рядка users: CRM пише candidate.erased у журнал і листи
 * компаніям, яким людина вже відкрила контакт (GDPR ст. 19). Виняток тут
 * зупиняє видалення: краще не видалити, ніж видалити мовчки.
 */
export async function notifyCrmErasure(userId: string): Promise<void> {
  void userId;
}

/**
 * Причина, чому акаунт зараз видаляти не можна, або null. Специфікація CRM
 * (розділ 13): останній власник компанії спершу передає її або закриває.
 * TODO(merge з доріжкою CRM): перевірка company_members, коли 0003_crm накотять.
 */
export async function crmErasureBlock(userId: string): Promise<string | null> {
  void userId;
  return null;
}
