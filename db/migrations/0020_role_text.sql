-- Своя роль словами людини: поле «My role is not in the list» на кроці ролей анкети (14.09).
-- NULL = немає. Ролі зі списку лишаються в users.roles; це лише доповнення.
-- Добірка (engine/src/digest/match.ts) і /jobs (web/src/lib/jobs/match.ts, копія) беруть ще й вакансії,
-- у назві яких є всі слова однієї фрази цього тексту («Tokenomics designer» → «Senior Tokenomics Designer»).
-- engine читає колонку з запасним запитом без неї, тож порядок деплою не важливий; web читає її одразу,
-- тож міграцію накочувати до деплою сайту.
ALTER TABLE users ADD COLUMN role_text TEXT;
