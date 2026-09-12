-- NextCryptoJob, перебудова подань доступу. Власник: web (оплата). Перелік: docs/contracts.md §7.
-- Специфікація: docs/specs/2026-09-12-crm-agents-design.md (2.3 і 8), рев'ю T8.
-- 0004 уже накочено на прод, тому подання не правимо там, а перестворюємо тут.
--
-- Що змінилось проти 0004:
-- 1. past_due: 7 діб пільги від current_period_start, а не від кінця періоду. Коли
--    продовження не проходить, Stripe уже зсунув період (початок = день невдалого
--    списання, кінець через місяць), тож "кінець + 7 діб" давав би доступ ще 5 тижнів.
-- 2. Рядок без current_period_end доступу не дає. Для usdc/manual його й так немає
--    (CHECK у 0004), а для Stripe без періоду це незавершений запис, не "назавжди".
-- Та сама умова продубльована в web/src/lib/billing/access.ts і web/src/lib/crm/context.ts
-- (там треба знайти сам рядок); тест звіряє, що всі три згодні.
-- Час: UTC у форматі datetime('now').

-- company_jobs_live читає company_access, тож спершу воно.
DROP VIEW IF EXISTS company_jobs_live;
DROP VIEW IF EXISTS company_access;

-- Хто має доступ до CRM зараз. Одне правило для web, REST, MCP і engine.
-- trialing/active: до кінця періоду (Stripe +2 доби на запізнілий вебхук продовження).
-- past_due: 7 діб від початку періоду, у якому не пройшло списання.
CREATE VIEW company_access AS
SELECT c.id AS company_id,
       CASE
         WHEN c.status <> 'active' THEN 'none'
         WHEN EXISTS (
           SELECT 1 FROM subscriptions s
           WHERE s.company_id = c.id
             AND ((s.status IN ('trialing', 'active')
                   AND datetime(s.current_period_end,
                                CASE s.provider WHEN 'stripe' THEN '+2 days' ELSE '+0 days' END) > datetime('now'))
               OR (s.status = 'past_due'
                   AND datetime(s.current_period_start, '+7 days') > datetime('now')))
         ) THEN 'subscription'
         ELSE 'pay_per_request'
       END AS access,
       (SELECT s.status FROM subscriptions s WHERE s.company_id = c.id
         ORDER BY s.created_at DESC LIMIT 1) AS latest_status
FROM companies c;

-- Живі вакансії компаній для рушія добірки (0006_digest) і публічного search_jobs.
-- Без змін проти 0004: лише відкриті, не приховані адміном, не прострочені, у компаній з підпискою.
CREATE VIEW company_jobs_live AS
SELECT j.id, j.company_id, j.title, j.description, j.roles, j.remote_mode, j.city, j.country,
       j.salary_min, j.salary_max, j.salary_currency, j.salary_period, j.apply_url, j.tags,
       j.published_at, j.expires_at,
       c.name AS company_name, c.domain AS company_domain,
       (c.domain_verified_at IS NOT NULL) AS company_domain_verified
FROM company_jobs j
JOIN companies c ON c.id = j.company_id
JOIN company_access a ON a.company_id = c.id
WHERE j.status = 'open'
  AND j.hidden_by_admin_at IS NULL
  AND j.expires_at > datetime('now')
  AND a.access = 'subscription';

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0012_access_views');
