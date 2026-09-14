// Місце вакансії: «віддалено» і «це місто» так само, як вирішує добірка engine.
//
// Сам код живе в nextrole-match.ts (дослівна копія engine/src/digest/match.ts, тест
// nextrole-parity.test.ts це звіряє). Тут лише ті функції, що потрібні search_jobs
// (lib/crm/public-jobs.ts) і пулу (nextrole-pool.ts).
export { cityVariants, foldText, isRemoteLocation, mentionsCity } from "./nextrole-match";
