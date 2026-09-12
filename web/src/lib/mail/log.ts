import type { Mailer } from "./index";

/**
 * Лист у журнал сервера замість пошти: для розробки, поки домен не
 * підключено до Email Service. У продакшені відмовляє: код входу в журналі
 * Worker прочитав би кожен, хто має доступ до логів.
 */
export const logMailer: Mailer = {
  async send({ to, subject, text }) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("logMailer is disabled in production");
    }
    console.info(`[mail:dev] to=${to}\nsubject: ${subject}\n\n${text}`);
  },
};
