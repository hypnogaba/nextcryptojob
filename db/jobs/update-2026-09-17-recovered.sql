-- 17.09.2026: компанії, чиї вакансії зникли разом із закритим board:jobstash, повернуті з їхніх власних дощок ATS.
-- Знайдено engine/scripts/recover-ats.ts (слаг з назви або сторінка кар'єри), кожна дошка перевірена живою відповіддю API.
-- Узято лише крипто-компанії: банки, брокери й платіжні компанії зі списку відповідей (Adyen, Block, State Street,
-- Robinhood, Virtu, Nium, Unlimit, Modern Treasury…) сюди не йдуть, бо їхня дошка це переважно не крипто-вакансії,
-- а збіги слага з чужою компанією (Lunar, Sui, Raven, Legion, Compound, Change) відкинуто за назвами їхніх вакансій.
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('workable:gomining', 'GoMining', 'workable', 'gomining', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 126 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('greenhouse:straitsx', 'StraitsX', 'greenhouse', 'straitsx', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 28 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('workday:bullish.wd3.Bullish', 'Bullish', 'workday', 'bullish.wd3.Bullish', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 27 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('teamtailor:spiko', 'Spiko', 'teamtailor', 'spiko', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 26 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('workday:bullish.wd3.CoinDesk', 'CoinDesk', 'workday', 'bullish.wd3.CoinDesk', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 19 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('ashby:coinflow', 'Coinflow', 'ashby', 'coinflow', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 15 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('greenhouse:startale', 'Startale Group Pte. Ltd.', 'greenhouse', 'startale', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 14 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('teamtailor:crystalintelligence', 'Crystal Intelligence', 'teamtailor', 'crystalintelligence', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 12 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('greenhouse:figure', 'Figure', 'greenhouse', 'figure', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 11 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('bamboohr:lightnet', 'Lightnet Group', 'bamboohr', 'lightnet', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 10 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('bamboohr:mercuryo', 'Mercuryo', 'bamboohr', 'mercuryo', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 9 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('lever:cleanspark', 'CleanSpark', 'lever', 'cleanspark', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 8 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('teamtailor:ctrlalt', 'Ctrl Alt', 'teamtailor', 'ctrlalt', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 8 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('ashby:satoshilabs', 'SatoshiLabs Group', 'ashby', 'satoshilabs', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 7 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('ashby:ava-labs', 'Ava Labs, Inc.', 'ashby', 'ava-labs', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 6 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('ashby:meow', 'Meow Technologies', 'ashby', 'meow', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 5 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('ashby:pod-network', 'Pod Network', 'ashby', 'pod-network', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 4 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('bamboohr:wirex', 'Wirex', 'bamboohr', 'wirex', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 4 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('recruitee:confirmo', 'Confirmo', 'recruitee', 'confirmo', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 4 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('greenhouse:galaxy', 'Galaxy Digital LP', 'greenhouse', 'galaxy', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 3 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('rippling:liminal', 'Liminal', 'rippling', 'liminal', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 3 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('recruitee:amdax', 'Amdax', 'recruitee', 'amdax', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 3 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('personio:tangany', 'Tangany GmbH', 'personio', 'tangany', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 3 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('recruitee:dwf', 'DWF Labs', 'recruitee', 'dwf', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 3 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('lever:jito', 'Jito', 'lever', 'jito', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 2 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('greenhouse:elwoodtechnologies', 'Elwood Technologies LLP', 'greenhouse', 'elwoodtechnologies', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 2 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('teamtailor:ripio', 'Ripio', 'teamtailor', 'ripio', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 2 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('ashby:plasma', 'Plasma Finance', 'ashby', 'plasma', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 2 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('smartrecruiters:coinjar', 'CoinJar', 'smartrecruiters', 'coinjar', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 2 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('teamtailor:certora', 'Certora', 'teamtailor', 'certora', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 2 вакансій на власній дошці');
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('bamboohr:hypernative', 'Hypernative', 'bamboohr', 'hypernative', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: 1 вакансій на власній дошці');

-- Компанії, чия дошка ATS 14.09 не відповіла (enabled=0), знайдені заново тим самим інструментом.
-- Перевірено за назвами вакансій: збіги з чужою компанією (bamboohr:sui, bamboohr:world, greenhouse:nexus,
-- bamboohr:lido «test», ashby:gelato) відкинуто, лишились чотири справжні.
UPDATE OR IGNORE companies SET ats_provider='rippling',       ats_slug='algorand-foundation', enabled=1, note='2026-09-17: дошка переїхала, знайдено заново (recover-ats)' WHERE name='Algorand Foundation';
UPDATE OR IGNORE companies SET ats_provider='smartrecruiters', ats_slug='hivemapper',          enabled=1, note='2026-09-17: дошка переїхала, знайдено заново (recover-ats)' WHERE name='Hivemapper';
UPDATE OR IGNORE companies SET ats_provider='ashby',           ats_slug='dourolabs.xyz',       enabled=1, note='2026-09-17: дошка переїхала, знайдено заново (recover-ats)' WHERE name='Douro Labs';
UPDATE OR IGNORE companies SET ats_provider='bamboohr',        ats_slug='spectral',            enabled=1, note='2026-09-17: дошка переїхала, знайдено заново (recover-ats)' WHERE name='Spectral';

-- Компанія зі списку розвідки «сторінка кар'єри без адреси ATS»: слаг з назви дав живу дошку.
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)
 VALUES ('smartrecruiters:auki', 'Auki Labs', 'smartrecruiters', 'auki', 1, 'recover-ats-2026-09-17', 'розвідка не знайшла ATS на сторінці кар''єри, слаг з назви дав дошку');
