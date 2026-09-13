import type { DatabaseSync } from "node:sqlite";
import { addCompany, addSubscription, addUsage, run, setConsent } from "./crm-fixtures";

/**
 * Дані для головної адмінки (/admin) на справжньому SQLite: по кілька рядків у кожній
 * таблиці, яку рахує lib/admin/overview.ts, з часом відносно OVERVIEW_NOW. Очікувані
 * числа в тестах виписано з цих рядків руками.
 */

/** Неділя, 12:00 UTC. Наступний прогін добірки о 12:05 UTC. */
export const OVERVIEW_NOW = new Date("2026-09-13T12:00:00.000Z");

export function seedOverview(raw: DatabaseSync): { companies: Record<string, string> } {
  // Кандидати. u1: сьогодні, пошта, анкета й «Stand out» пройдено, видимий, Париж о 14:00 (= 12:05 UTC).
  run(
    raw,
    `INSERT INTO users (id, email, telegram_id, channel, roles, onboarding_step, visible_to_companies, digest_hour,
                        timezone, digest_paused, created_at) VALUES
       ('u1', 'u1@example.com', NULL, 'email', '["engineer"]', 'done', 1, 14, 'Europe/Paris', 0, '2026-09-13 08:00:00'),
       ('u2', NULL, '200', 'telegram', '["bd"]', 'roles', 0, 7, NULL, 1, '2026-09-10 09:00:00'),
       ('u3', 'u3@example.com', '300', 'telegram', '["trader"]', 'wallets', 0, 7, NULL, 0, '2026-08-20 09:00:00'),
       ('u4', 'u4@example.com', NULL, 'email', '[]', NULL, 0, 7, NULL, 0, '2026-07-01 09:00:00')`,
  );
  setConsent(raw, "u1", "scoring", true);
  setConsent(raw, "u3", "scoring", true);
  // u2 дав згоду, але анкету не пройшов: у «brief done» не рахується.
  setConsent(raw, "u2", "scoring", true);
  run(
    raw,
    `INSERT INTO identities (user_id, kind, value, verified_via, verified_at) VALUES
       ('u1', 'x', 'ada', 'bio_code', '2026-09-13 09:00:00'),
       ('u3', 'x', 'bob', NULL, NULL),
       ('u3', 'evm', '0x1111111111111111111111111111111111111111', NULL, NULL),
       ('u3', 'solana', 'So11111111111111111111111111111111111111112', NULL, NULL)`,
  );
  run(
    raw,
    `INSERT INTO cards (slug, user_id, role, score, level, display_name, formula_version, revoked_at) VALUES
       ('card000001', 'u1', 'engineer', 71, 8, 'Ada', 'v6', NULL),
       ('card000002', 'u3', 'trader', 40, 5, 'Bob', 'v5', '2026-09-12 00:00:00')`,
  );

  // Бал: u1 на v6 (є вдалий прогін воріт), u3 на v5 (немає).
  run(
    raw,
    `INSERT INTO scores (user_id, role, score, core, cover, breakdown_json, formula_version, computed_at) VALUES
       ('u1', 'engineer', 71, 70, 100, '{}', 'v6', '2026-09-13 11:50:00'),
       ('u1', 'devrel', 30, 30, 50, '{}', 'v6', '2026-09-13 11:50:00'),
       ('u3', 'trader', 40, 40, 90, '{}', 'v5', '2026-09-02 10:00:00')`,
  );
  run(
    raw,
    `INSERT INTO quality_runs (formula_version, people, exact_pct, near_pct, unscored, report_json, passed, run_at) VALUES
       ('v5', 49, 40.8, 83.7, 2, '{}', 0, '2026-09-10 10:00:00'),
       ('v6', 49, 42.9, 85.7, 2, '{}', 1, '2026-09-12 10:00:00')`,
  );
  run(
    raw,
    `INSERT INTO score_jobs (user_id, reason, status, queued_at, started_at, finished_at, error) VALUES
       ('u1', 'manual', 'queued', '2026-09-13 11:30:00', NULL, NULL, NULL),
       ('u2', 'connect', 'queued', '2026-09-13 11:45:00', NULL, NULL, NULL),
       ('u3', 'refresh', 'running', '2026-09-13 11:40:00', '2026-09-13 11:55:00', NULL, NULL),
       ('u2', 'connect', 'failed', '2026-09-13 05:00:00', '2026-09-13 05:01:00', '2026-09-13 06:00:00', 'x: timeout'),
       ('u1', 'connect', 'done', '2026-09-13 11:48:00', '2026-09-13 11:49:00', '2026-09-13 11:50:00', NULL),
       ('u3', 'connect', 'failed', '2026-09-01 10:00:00', '2026-09-01 10:01:00', '2026-09-01 10:02:00', 'old')`,
  );

  // Добірки: сьогодні, вчора, 10.09 і поза тижнем (01.09).
  run(
    raw,
    `INSERT INTO digest_runs (id, user_id, local_date, status, jobs, channel, error, created_at) VALUES
       ('dg_1', 'u1', '2026-09-13', 'sent', 5, 'telegram', NULL, '2026-09-13 07:05:00'),
       ('dg_2', 'u3', '2026-09-13', 'failed', 4, 'telegram', 'Telegram 403: bot was blocked by the user', '2026-09-13 07:05:10'),
       ('dg_3', 'u1', '2026-09-12', 'sent', 3, 'email', 'sent by email instead', '2026-09-12 07:05:00'),
       ('dg_4', 'u3', '2026-09-12', 'empty', 0, NULL, NULL, '2026-09-12 07:05:00'),
       ('dg_5', 'u3', '2026-09-10', 'failed', 5, 'telegram', 'Telegram 403: bot was blocked by the user', '2026-09-10 07:05:00'),
       ('dg_6', 'u2', '2026-09-13', 'pending', 2, NULL, NULL, '2026-09-13 11:00:00'),
       ('dg_7', 'u1', '2026-09-01', 'sent', 5, 'email', NULL, '2026-09-01 07:05:00')`,
  );

  // Компанії: пробна, з підпискою, без підписки, агенція на розгляді, закрита.
  const trial = addCompany(raw, { name: "Trial Co" });
  addSubscription(raw, trial, { status: "trialing" });
  const sub = addCompany(raw, { name: "Paying Co" });
  addSubscription(raw, sub, { status: "active" });
  const ppr = addCompany(raw, { name: "Per Request Co" });
  const agency = addCompany(raw, { name: "Hire Co", kind: "agency", status: "pending_review" });
  const closed = addCompany(raw, { name: "Gone Co", status: "closed" });
  run(
    raw,
    `INSERT INTO agency_applications (id, company_id, contact_name, contact_email, website, country, clients_text,
                                      data_use_text, no_resale_ack, status)
     VALUES ('app_00000000000000000001', ?, 'Ann', 'ann@hire.co', 'https://hire.co', 'GB', 'DeFi', 'Contact only', 1, 'pending')`,
    agency,
  );
  run(
    raw,
    `INSERT INTO company_members (company_id, user_id, role, joined_at) VALUES (?, 'u4', 'owner', '2026-09-01 00:00:00')`,
    sub,
  );
  run(
    raw,
    `INSERT INTO company_members (company_id, user_id, role, invite_email, invited_at) VALUES
       (?, NULL, 'member', 'new@paying.co', '2026-09-12 10:00:00'),
       (?, NULL, 'member', 'old@paying.co', '2026-08-01 10:00:00')`,
    sub,
    sub,
  );
  addUsage(raw, 3, { companyId: sub, action: "search_candidates", at: "2026-09-12 10:00:00" });
  addUsage(raw, 1, { companyId: sub, action: "search_candidates", at: "2026-09-12 10:00:00", status: 429 });
  addUsage(raw, 2, { companyId: sub, action: "get_candidate", at: "2026-09-11 10:00:00" });
  addUsage(raw, 5, { companyId: sub, action: "search_candidates", at: "2026-08-01 10:00:00" });
  run(
    raw,
    `INSERT INTO intros (id, company_id, user_id, mode, status, message, requested_via, expires_at, contact_kind,
                         contact_value, created_at) VALUES
       ('int_00000000000000000001', ?, 'u1', 'approval', 'pending', 'We would like to talk about a role.', 'web',
        '2026-09-26 00:00:00', NULL, NULL, '2026-09-12 10:00:00'),
       ('int_00000000000000000002', ?, 'u3', 'approval', 'accepted', 'We would like to talk about a role.', 'rest',
        '2026-09-20 00:00:00', 'telegram', '@bob', '2026-09-01 10:00:00')`,
    sub,
    sub,
  );
  run(
    raw,
    `INSERT INTO company_jobs (id, company_id, status, title, apply_url, published_at, expires_at, created_via,
                               apply_clicks, x_post_state) VALUES
       ('job_00000000000000000001', ?, 'open', 'Solidity engineer', 'https://paying.co/jobs/1', '2026-09-10 00:00:00',
        '2027-01-01 00:00:00', 'web', 4, 'queued'),
       ('job_00000000000000000002', ?, 'open', 'Designer', 'https://ppr.co/jobs/2', '2026-09-10 00:00:00',
        '2027-01-01 00:00:00', 'web', 1, 'none'),
       ('job_00000000000000000003', ?, 'closed', 'Old role', 'https://paying.co/jobs/3', '2026-06-01 00:00:00',
        '2026-08-01 00:00:00', 'web', 2, 'none')`,
    sub,
    ppr,
    sub,
  );

  // Оплати x402: розрахована, розрахована без результату (чекає повернення), зависла бронь, непідтверджена.
  const pay = (id: string, status: string, cents: number, createdAt: string, noResult: string | null) =>
    run(
      raw,
      `INSERT INTO x402_payments (id, payload_hash, request_hash, company_id, network, asset, pay_to, amount_atomic,
                                  amount_usd_cents, action, channel, status, facilitator, created_at, no_result_at)
       VALUES (?, ?, 'rh', ?, 'eip155:84532', 'usdc', 'to', '1', ?, 'search_candidates', 'rest', ?, 'x402org', ?, ?)`,
      id,
      `ph_${id}`,
      sub,
      cents,
      status,
      createdAt,
      noResult,
    );
  pay("pay_00000000000000000001", "settled", 50, "2026-09-12 10:00:00", null);
  pay("pay_00000000000000000002", "settled", 500, "2026-09-12 11:00:00", "2026-09-12 11:00:01");
  pay("pay_00000000000000000003", "verified", 50, "2026-09-13 11:50:00", null);
  pay("pay_00000000000000000004", "unconfirmed", 50, "2026-09-13 11:59:00", null);

  // Cron: журнал ведеться з 12.09 03:00 (прибирання), 5-хвилинні свіжі, одна задача впала,
  // x402.stale не запускалась жодного разу.
  run(
    raw,
    `INSERT INTO cron_runs (job, cron, started_at, ms, ok, counts_json, error) VALUES
       ('cleanup.daily', '0 3 * * *', '2026-09-12 03:00:00', 900, 1, '{"sessions":2}', NULL),
       ('webhooks.deliver', '*/5 * * * *', '2026-09-13 10:00:00', 20, 0, NULL, 'D1_ERROR: earlier'),
       ('jobs.expire', '0 * * * *', '2026-09-13 11:00:00', 40, 1, '{"closed":0}', NULL),
       ('saved_searches.alert', '0 * * * *', '2026-09-13 11:00:01', 300, 1, '{"alerts":1}', NULL),
       ('intros.expire', '*/5 * * * *', '2026-09-13 11:55:00', 15, 1, '{"expired":0}', NULL),
       ('webhooks.deliver', '*/5 * * * *', '2026-09-13 11:55:01', 1200, 0, NULL, 'D1_ERROR: boom')`,
  );

  return { companies: { trial, sub, ppr, agency, closed } };
}
