-- NextCryptoJob, база вакансій: оцінка зарплати від дошки, окремо від вилки роботодавця (14.09.2026).
--
-- web3.career (офіційний API) віддає поруч із вилкою роботодавця (`salary_min_value`/`max`) власну
-- оцінку (`estimated_min_salary`/`max`) для вакансій, де роботодавець вилки не дав. Оцінка не
-- пропозиція роботодавця, тож вона НІКОЛИ не йде в salary_min/salary_max: ні в підбір добірки за
-- зарплатою, ні в лічильник «з зарплатою», ні в розмітку JobPosting. Сайт і добірка показують її лише
-- приглушеним рядком «est. $Xk to $Yk (web3.career estimate)», search_jobs віддає окремим полем
-- salary_estimate. Суми річні, як і salary_min (engine/src/jobs/pay.ts); чия оцінка, каже jobs_cache.source.
--
-- Нові стовпці без індексів: запис рядка коштує стільки ж, скільки й до них (0001_schema.sql).
-- Накочувати ДО нового engine і сайту: обидва читають і пишуть ці стовпці.
ALTER TABLE jobs_cache ADD COLUMN salary_est_min INTEGER;
ALTER TABLE jobs_cache ADD COLUMN salary_est_max INTEGER;
ALTER TABLE jobs_cache ADD COLUMN salary_est_currency TEXT;

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0002_salary_estimate');
