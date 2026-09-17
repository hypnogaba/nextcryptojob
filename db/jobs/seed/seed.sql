-- Засів бази вакансій NextCryptoJob. ЗГЕНЕРОВАНО з db/jobs/seed/registry.json командою
--   cd engine && npx tsx scripts/jobs-seed.ts sql
-- Правити registry.json (або скрипт), а не цей файл: тест звіряє їх.
-- Накочувати після 0001_schema.sql: wrangler d1 execute nextcryptojob-jobs --remote --file db/jobs/seed/seed.sql
-- Джерело: public registry fields exported once from an earlier job database of the same owner on 2026-09-14 (companies tagged web3, global boards, crypto Getro collections) plus hand-checked additions and companies found through ecosystem and fund job boards on 2026-09-14; see engine/scripts/jobs-seed.ts
INSERT INTO sources (name, label, kind, feed_url, site_url, crypto_only, enabled, terms_note) VALUES ('aggregator:speedrun', 'a16z speedrun', 'speedrun', 'https://speedrun-talent-network.com/api/v1', 'https://speedrun-talent-network.com', 1, 1, 'documented open API (/developers: reads are open and unauthenticated); we pass ?source= and keep their links') ON CONFLICT(name) DO NOTHING;
INSERT INTO sources (name, label, kind, feed_url, site_url, crypto_only, enabled, terms_note) VALUES ('board:jobstash', 'JobStash', 'nextjs', 'https://jobstash.xyz/', 'https://jobstash.xyz', 0, 1, 'no terms found, robots.txt Allow: /; only jobs the board itself marks crypto are kept') ON CONFLICT(name) DO NOTHING;
INSERT INTO sources (name, label, kind, feed_url, site_url, crypto_only, enabled, terms_note) VALUES ('board:remote3', 'Remote3', 'rss', 'https://www.remote3.co/api/rss', 'https://remote3.co', 1, 1, 'their own RSS only (/api/rss); terms forbid automated searches of the site, so no HTML') ON CONFLICT(name) DO NOTHING;
INSERT INTO sources (name, label, kind, feed_url, site_url, crypto_only, enabled, terms_note) VALUES ('board:web3career', 'Web3.career', 'jsonld', 'https://web3.career/api/v1', 'https://web3.career', 1, 1, 'official Web3 Jobs API with our token (WEB3CAREER_TOKEN, since 2026-09-14), read by src/jobs/sources/web3career.ts whatever the kind; terms: link to apply_url unchanged with a follow link (no nofollow, no added params), name web3.career as the source, token private') ON CONFLICT(name) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (203, 'Polychain', 'https://jobs.polychain.capital/jobs', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (390, 'Multicoin', 'https://jobs.multicoin.capital/jobs', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (815, 'Blockchain Capital', 'https://blockchaincapital.com', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (858, 'Solana', 'https://jobs.solana.com/jobs', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (869, 'Blockchain Association', 'https://theblockchainassociation.org', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (922, 'Placeholder', 'https://placeholder.vc', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (944, 'Paradigm', 'https://paradigm.xyz', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (1118, 'Dragonfly', 'https://jobs.dragonfly.xyz/jobs', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (1127, 'Framework Ventures', 'https://framework.ventures', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (1179, 'Spartan Group', 'https://spartangroup.io', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (1440, 'Delphi Ventures', 'https://delphiventures.io', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (1508, 'Variant Fund', 'https://variant.fund', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (1524, 'Outlier Ventures', 'https://outlierventures.io', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (1625, 'Coinbase', 'https://coinbase.com', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (1640, 'Electric Capital', 'https://jobs.electriccapital.com/jobs', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (4184, 'Arbitrum', 'https://jobs.arbitrum.io', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (6230, 'Animoca Brands', 'https://careers.animocabrands.com', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (10223, 'Avalanche', 'https://jobs.avax.network/jobs', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (13362, 'Castle Island Ventures', 'https://jobs.castleisland.vc', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (13457, 'Monad', 'https://eco-jobs.monad.xyz', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (13490, 'Injective', 'https://injective.getro.com', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO getro_collections (collection_id, label, url, enabled) VALUES (20916, 'Jump Crypto', 'https://jobs.jumpcrypto.com', 1) ON CONFLICT(collection_id) DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('0g', 'Zero Gravity', 'ashby', '0g', 1, 'seed', NULL),
  ('0x', '0x', 'ashby', '0x', 1, 'seed', NULL),
  ('1inch', '1inch Network', 'lever', '1inch', 1, 'seed', NULL),
  ('1kosmos', '1Kosmos - BlockID', 'workable', '1kosmos', 1, 'seed', NULL),
  ('21shares', '21Shares', 'greenhouse', '21shares', 1, 'seed', NULL),
  ('3jane', '3Jane', 'lever', '3jane', 1, 'portfolio:paradigm', 'listed on the public portfolio page https://www.paradigm.xyz/investments; company site https://www.3jane.xyz/ careers page https://www.3jane.xyz/ links lever:3jane (0 open on 2026-09-14)'),
  ('a16z', 'a16z', 'greenhouse', 'a16z', 1, 'seed', NULL),
  ('aavelabs', 'Aave Labs', 'lever_eu', 'aavelabs', 1, 'seed', NULL),
  ('akashnetwork', 'Akash Network', 'lever', 'akashnetwork', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('alchemy', 'Alchemy', 'ashby', 'alchemy', 1, 'seed', NULL),
  ('algorand-foundation', 'Algorand', 'rippling', 'algorand-foundation', 1, 'seed', NULL),
  ('algorandfoundation', 'Algorand Foundation', 'bamboohr', 'algorandfoundation', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('alliance', 'Alliance', 'breezy', 'alliance', 1, 'seed', NULL),
  ('alloralabs', 'Allora Labs', 'bamboohr', 'alloralabs', 1, 'portfolio:mechanism', 'listed on the public portfolio page https://www.mechanism.capital/portfolio; company site https://allora.network/ careers page https://allora.network/ links bamboohr:alloralabs (0 open on 2026-09-14)'),
  ('alpaca', 'Alpaca', 'greenhouse', 'alpaca', 1, 'seed', NULL),
  ('alpenlabs', 'Alpen Labs', 'ashby', 'alpenlabs', 1, 'seed', NULL),
  ('ambergroup', 'Amber Group', 'bamboohr', 'ambergroup', 1, 'seed', NULL),
  ('anagram-ashby', 'Anagram', 'ashby', 'anagram', 1, 'seed', NULL),
  ('anchorage', 'Anchorage Digital', 'lever', 'anchorage', 1, 'seed', NULL),
  ('animocabrands', 'Animoca Brands', 'lever', 'animocabrands', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('anomali', 'Anomali', 'lever', 'anomali', 0, 'seed', 'disabled at seed: not crypto (threat intelligence)'),
  ('antimetal', 'Antimetal', 'ashby', 'antimetal', 0, 'seed', 'disabled at seed: not crypto (cloud cost software)'),
  ('anza-xyz', 'Anza', 'workable', 'anza-xyz', 1, 'seed', NULL),
  ('aptosfoundation', 'Aptos Foundation', 'ashby', 'aptosfoundation', 1, 'seed', NULL),
  ('aptoslabs', 'Aptos Labs', 'greenhouse', 'aptoslabs', 1, 'seed', NULL),
  ('arbitrumfoundation', 'Arbitrum', 'lever', 'arbitrumfoundation', 1, 'seed', NULL),
  ('arenaclub', 'Arena Club', 'greenhouse', 'arenaclub', 1, 'seed', NULL),
  ('arq', 'DolarApp', 'ashby', 'arq', 1, 'seed', NULL),
  ('asula', 'Asula', 'ashby', 'asula', 1, 'seed', NULL),
  ('asymmetric', 'Wormhole', 'ashby', 'asymmetric', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('asymmetric.re', 'Wormhole (Asymmetric)', 'ashby', 'asymmetric.re', 1, 'seed', NULL),
  ('aurora-dev', 'Aurora', 'lever', 'aurora-dev', 1, 'seed', NULL),
  ('aurosglobal', 'Auros', 'greenhouse', 'aurosglobal', 1, 'seed', NULL),
  ('ava-labs', 'Ava Labs', 'ashby', 'ava-labs', 1, 'seed', NULL),
  ('avalanche-foundation', 'Avalanche Foundation', 'ashby', 'avalanche-foundation', 1, 'seed', NULL),
  ('aven', 'Aven', 'ashby', 'aven', 1, 'seed', NULL),
  ('axiom', 'Axiom (axiom.xyz)', 'ashby', 'axiom', 1, 'portfolio:paradigm', 'listed on the public portfolio page https://www.paradigm.xyz/investments; company site https://www.axiom.xyz/ careers page https://www.axiom.xyz/ links ashby:axiom (3 open on 2026-09-14)'),
  ('azragames', 'Azra Games', 'greenhouse', 'azragames', 1, 'seed', NULL),
  ('azragamesoa', 'Azra Games', 'greenhouse', 'azragamesoa', 1, 'seed', NULL),
  ('aztec-labs', 'Aztec Labs', 'ashby', 'aztec-labs', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('b2c2', 'B2C2', 'greenhouse', 'b2c2', 1, 'seed', NULL),
  ('basejobs', 'Spindl', 'greenhouse', 'basejobs', 1, 'seed', NULL),
  ('basicblock-inc', 'BasicBlock', 'breezy', 'basicblock-inc', 1, 'seed', NULL),
  ('bastion', 'Dibbs', 'ashby', 'bastion', 1, 'seed', NULL),
  ('batoncorporation', 'Baton Corporation', 'ashby', 'batoncorporation', 1, 'seed', NULL),
  ('bcb-group', 'BCB Group', 'greenhouse', 'bcbgroup', 1, 'curated', 'board name ''BCB Group'' on the EU Greenhouse host (1 open on 2026-09-14; bcbgroup.com/careers lists the same role); crypto payments'),
  ('bettermoney', 'The Better Money Company', 'ashby', 'bettermoney', 1, 'portfolio:a16z-crypto', 'listed on the public portfolio page https://a16zcrypto.com/portfolio/; company site https://bettermoney.com/ careers page https://bettermoney.com/ links ashby:bettermoney (6 open on 2026-09-14)'),
  ('biconomy', 'Biconomy', 'lever', 'biconomy', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('binance', 'Binance', 'lever', 'binance', 1, 'seed', NULL),
  ('bio', 'Bio Protocol', 'ashby', 'bio', 1, 'portfolio:protocol-labs', 'Protocol Labs network directory https://os.pl.xyz/jobs (read once on 2026-09-14) lists this team''s roles at ashby:bio (11 open on 2026-09-14)'),
  ('bitdeer', 'BitDeer', 'breezy', 'bitdeer', 1, 'seed', NULL),
  ('bitgo', 'BitGo', 'greenhouse', 'bitgo', 1, 'seed', NULL),
  ('bitpanda', 'Bitpanda', 'greenhouse', 'bitpanda', 1, 'seed', NULL),
  ('bitso', 'Bitso', 'greenhouse', 'bitso', 1, 'seed', NULL),
  ('bitvavo', 'Bitvavo', 'ashby', 'bitvavo', 1, 'seed', NULL),
  ('bitwave', 'Bitwave', 'breezy', 'bitwave', 1, 'seed', NULL),
  ('bitwise-asset-management-inc', 'Bitwise Asset Management', 'rippling', 'bitwise-asset-management-inc', 1, 'seed', NULL),
  ('blackbird-labs-inc', 'Blackbird Labs', 'ashby', 'blackbird-labs-inc', 1, 'seed', NULL),
  ('blockchain', 'Blockchain.com', 'greenhouse', 'blockchain', 1, 'seed', NULL),
  ('blockdaemon', 'Blockdaemon', 'ashby', 'blockdaemon', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('blockstream', 'Blockstream', 'ashby', 'blockstream', 1, 'seed', NULL),
  ('blockworks', 'Blockworks', 'ashby', 'blockworks', 1, 'seed', NULL),
  ('blue-cube-services', 'Blue Cube Services', 'greenhouse', 'bluecubeservices', 1, 'curated', 'board name ''Blue Cube Services'', customer and user operations for crypto partners (8 open on 2026-09-14); listed by web3.career'),
  ('bluefin', 'Bluefin', 'workable', 'bluefin', 1, 'portfolio:mechanism', 'listed on the public portfolio page https://www.mechanism.capital/portfolio; company site https://bluefin.io/ careers page https://bluefin.io/careers links workable:bluefin (0 open on 2026-09-14)'),
  ('bluenote', 'Bluenote Health', 'ashby', 'bluenote', 0, 'seed', 'disabled at seed: not crypto (healthcare)'),
  ('brave', 'Basic Attention Token', 'greenhouse', 'brave', 1, 'seed', NULL),
  ('breezecash', 'Breeze', 'greenhouse', 'breezecash', 1, 'seed', NULL),
  ('bugcrowd', 'Bugcrowd', 'greenhouse', 'bugcrowd', 0, 'seed', 'disabled at seed: not crypto (general bug bounty platform)'),
  ('busha', 'Busha', 'breezy', 'busha', 1, 'seed', NULL),
  ('button', 'Button', 'ashby', 'button', 0, 'seed', 'disabled at seed: not crypto (mobile commerce)'),
  ('bvnk', 'BVNK', 'greenhouse', 'bvnk', 1, 'seed', NULL),
  ('bybit', 'Bybit', 'greenhouse', 'bybit', 1, 'seed', NULL),
  ('caladan', 'Caladan', 'greenhouse', 'caladan', 1, 'seed', NULL),
  ('cardano-foundation', 'Cardano Foundation', 'personio', 'cardano-foundation', 1, 'curated', 'Cardano ecosystem check 2026-09-14: cardano-foundation.jobs.personio.com answers with the Cardano Foundation''s roles (1 open on 2026-09-14)'),
  ('casa', 'Casa', 'greenhouse', 'casa', 1, 'seed', NULL),
  ('category-labs', 'Category Labs', 'ashby', 'category-labs', 1, 'seed', NULL),
  ('catena', 'Catena Labs', 'ashby', 'catena', 1, 'portfolio:a16z-crypto', 'listed on the public portfolio page https://a16zcrypto.com/portfolio/; company site https://catenalabs.com/ careers page https://catenalabs.com/careers links ashby:catena (4 open on 2026-09-14)'),
  ('celestia', 'Celestia Labs', 'lever', 'celestia', 1, 'seed', NULL),
  ('centrifuge', 'Centrifuge', 'lever', 'centrifuge', 1, 'seed', NULL),
  ('certik', 'CertiK', 'lever', 'certik', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('chainalysis-careers', 'Chainalysis', 'ashby', 'chainalysis-careers', 1, 'seed', NULL),
  ('chainalysis-government-solutions', 'Chainalysis Government Solutions', 'ashby', 'chainalysis-government-solutions', 1, 'seed', NULL),
  ('chainlink-labs', 'Chainlink Labs', 'ashby', 'chainlink-labs', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('chainstack', 'Chainstack', 'bamboohr', 'chainstack', 1, 'seed', NULL),
  ('chainwaylabs', 'Citrea', 'bamboohr', 'chainwaylabs', 1, 'getro:9134', 'found via getro:9134 (Galaxy Ventures board, only there): its jobs link bamboohr:chainwaylabs (1 open on 2026-09-14)'),
  ('chakra-labs', 'Chakra Labs', 'ashby', 'chakra-labs', 1, 'seed', NULL),
  ('codex', 'Codex', 'ashby', 'codex', 1, 'seed', NULL),
  ('coin-metrics', 'Coin Metrics', 'rippling', 'coin-metrics', 1, 'seed', NULL),
  ('coinbase', 'Coinbase', 'greenhouse', 'coinbase', 1, 'seed', NULL),
  ('coinflow', 'Coinflow Labs', 'ashby', 'coinflow', 1, 'seed', NULL),
  ('coingecko', 'CoinGecko', 'lever', 'coingecko', 1, 'seed', NULL),
  ('coinhako', 'CoinHako', 'ashby', 'coinhako', 1, 'seed', NULL),
  ('coinme', 'Coinme', 'greenhouse', 'coinme', 1, 'seed', NULL),
  ('coins', 'Coins.ph', 'lever', 'coins', 1, 'seed', NULL),
  ('cointracker', 'CoinTracker', 'ashby', 'cointracker', 1, 'seed', NULL),
  ('commonware', 'Commonware', 'ashby', 'commonware', 1, 'seed', NULL),
  ('compass-mining', 'Compass Mining', 'rippling', 'compass-mining', 1, 'seed', NULL),
  ('conduit', 'Conduit', 'ashby', 'conduit', 1, 'seed', NULL),
  ('connext-network', 'Everclear (Connext)', 'lever', 'connext-network', 1, 'portfolio:hashed', 'listed on the public portfolio page https://www.hashed.com/portfolio/; company site https://www.connext.network/ careers page https://www.connext.network/ links lever:connext-network (1 open on 2026-09-14)'),
  ('consensys', 'Consensys', 'greenhouse', 'consensys', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('contro', 'Controverse', 'breezy', 'contro', 1, 'seed', NULL),
  ('copperco', 'Copper', 'greenhouse', 'copperco', 1, 'seed', NULL),
  ('cosmoslabs', 'Cosmos Labs', 'greenhouse', 'cosmoslabs', 1, 'seed', NULL),
  ('cow-dao', 'CoW DAO', 'ashby', 'cow-dao', 1, 'seed', NULL),
  ('crossmint', 'Crossmint', 'teamtailor', 'crossmint.na', 1, 'curated', 'crossmint.com/careers links crossmint.na.teamtailor.com (jobs.rss, 5 open on 2026-09-14)'),
  ('cryptio', 'Cryptio', 'ashby', 'cryptio', 1, 'seed', NULL),
  ('crypto', 'Crypto.com', 'lever', 'crypto', 1, 'seed', NULL),
  ('cubesoftware', 'Cube', 'ashby', 'cubesoftware', 1, 'seed', NULL),
  ('cyber.fund', 'cyber•Fund', 'ashby', 'cyber.Fund', 1, 'getro:9035', 'found via getro:9035 (cyber.fund board, only there): its jobs link ashby:cyber.Fund (1 open on 2026-09-14)'),
  ('d3', 'D3', 'greenhouse', 'd3', 1, 'seed', NULL),
  ('dakota', 'Dakota', 'ashby', 'dakota', 1, 'seed', NULL),
  ('daylight', 'Daylight Energy', 'greenhouse', 'daylight', 1, 'seed', NULL),
  ('deblock', 'Deblock', 'workable', 'deblock', 1, 'seed', NULL),
  ('deepwatchinc', 'Dassana', 'greenhouse', 'deepwatchinc', 0, 'seed', 'disabled at seed: not crypto (security data software)'),
  ('delphi', 'Delphi Digital', 'ashby', 'delphi', 1, 'seed', NULL),
  ('dex-labs', 'DerivaDEX', 'breezy', 'dex-labs', 1, 'seed', NULL),
  ('distributedcrafts', 'BOB (Build on Bitcoin)', 'workable', 'distributedcrafts', 1, 'portfolio:mechanism', 'listed on the public portfolio page https://www.mechanism.capital/portfolio; company site https://gobob.xyz/ careers page https://gobob.xyz/ links workable:distributedcrafts (0 open on 2026-09-14)'),
  ('divineresearch', 'Divine', 'ashby', 'divineresearch', 1, 'seed', NULL),
  ('doublezero', 'DoubleZero', 'ashby', 'doublezero', 1, 'seed', NULL),
  ('dourolabs', 'Douro Labs', 'ashby', 'dourolabs', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14')
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('dourolabs.xyz', 'Douro Labs', 'ashby', 'dourolabs.xyz', 1, 'seed', NULL),
  ('drivewealth', 'DriveWealth', 'greenhouse', 'drivewealth', 0, 'seed', 'disabled at seed: not crypto (brokerage infrastructure)'),
  ('drweng', 'Cumberland', 'greenhouse', 'drweng', 1, 'seed', NULL),
  ('dune', 'Dune', 'ashby', 'dune', 1, 'seed', NULL),
  ('dv-trading', 'DV Trading', 'greenhouse', 'dvtrading', 1, 'curated', 'board name ''DV Trading'' (67 open, 18 posted within 30 days on 2026-09-14); proprietary trading firm with the crypto desk DV Chain, all roles also listed by web3.career'),
  ('eclipse', 'Eclipse', 'greenhouse', 'eclipse', 1, 'seed', NULL),
  ('ecoinc', 'Eco', 'greenhouse', 'ecoinc', 1, 'portfolio:a16z-crypto', 'listed on the public portfolio page https://a16zcrypto.com/portfolio/ (also 1kx); company site https://www.eco.com/ careers page https://www.eco.com/ links greenhouse:ecoinc (0 open on 2026-09-14)'),
  ('edisyl', 'Flipside', 'ashby', 'edisyl', 1, 'seed', NULL),
  ('eigen-labs', 'EigenLayer', 'ashby', 'eigen-labs', 1, 'seed', NULL),
  ('eisen', 'Eisen', 'ashby', 'eisen', 1, 'seed', NULL),
  ('electriccapital', 'Electric Capital', 'rippling', 'electriccapital', 1, 'seed', NULL),
  ('ellipsislabs', 'Ellipsis Labs', 'ashby', 'ellipsislabs', 1, 'seed', NULL),
  ('elliptic', 'Elliptic', 'ashby', 'elliptic', 1, 'seed', NULL),
  ('eluvio', 'Eluvio', 'workable', 'eluvio', 1, 'seed', NULL),
  ('elwoodtechnologies', 'Elwood Technologies', 'greenhouse', 'elwoodtechnologies', 1, 'seed', NULL),
  ('ergonia', 'Ergonia', 'workable', 'ergonia', 1, 'seed', NULL),
  ('espresso', 'Espresso Systems', 'lever', 'espresso', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('ethena', 'Ethena', 'lever', 'ethena', 1, 'seed', NULL),
  ('ether.fi', 'Ether.fi', 'ashby', 'ether.fi', 1, 'seed', NULL),
  ('ethereum-foundation', 'Ethereum Foundation', 'ashby', 'ethereum-foundation', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('everstake', 'Everstake', 'bamboohr', 'everstake', 1, 'seed', NULL),
  ('everyrealm', 'Everyrealm', 'workable', 'everyrealm', 1, 'portfolio:a16z-crypto', 'listed on the public portfolio page https://a16zcrypto.com/portfolio/ (also hashed); company site https://everyrealm.com/ careers page https://everyrealm.com/careers links workable:everyrealm (0 open on 2026-09-14)'),
  ('exodus54', 'Exodus', 'greenhouse', 'exodus54', 1, 'seed', NULL),
  ('falconx', 'FalconX', 'greenhouse', 'falconx', 1, 'seed', NULL),
  ('fence-finance', 'Fence', 'ashby', 'fence-finance', 1, 'getro:9134', 'found via getro:9134 (Galaxy Ventures board, only there): its jobs link ashby:fence-finance (4 open on 2026-09-14)'),
  ('figment', 'Figment', 'greenhouse', 'figment', 1, 'seed', NULL),
  ('figure', 'Figure Markets', 'greenhouse', 'figure', 1, 'seed', NULL),
  ('filecoinfoundation', 'Filecoin', 'greenhouse', 'filecoinfoundation', 1, 'seed', NULL),
  ('fin', 'Fin', 'ashby', 'fin', 1, 'seed', NULL),
  ('fireblocks', 'Fireblocks', 'greenhouse', 'fireblocks', 1, 'seed', NULL),
  ('fleek', 'Fleek', 'ashby', 'fleek', 1, 'portfolio:protocol-labs', 'Protocol Labs network directory https://os.pl.xyz/jobs (read once on 2026-09-14) lists this team''s roles at ashby:fleek (11 open on 2026-09-14)'),
  ('flowdesk', 'Flowdesk', 'workable', 'flowdesk', 1, 'seed', NULL),
  ('flowtraders', 'Flow Traders', 'greenhouse', 'flowtraders', 1, 'seed', NULL),
  ('fomo-labs', 'Fomo', 'ashby', 'fomo-labs', 1, 'seed', NULL),
  ('fsl', 'STEPN', 'bamboohr', 'fsl', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('fuellabs', 'Fuel Labs', 'lever', 'fuellabs', 1, 'seed', NULL),
  ('fulcrumpro', 'Fulcrum', 'lever', 'fulcrumpro', 1, 'seed', NULL),
  ('futureverse', 'Altered State Machine', 'workable', 'futureverse', 1, 'seed', NULL),
  ('galaxydigitalservices', 'Galaxy Digital', 'greenhouse', 'galaxydigitalservices', 1, 'seed', NULL),
  ('gamesight', 'Gamesight', 'rippling', 'gamesight', 0, 'seed', 'disabled at seed: not crypto (game marketing)')
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('gate', 'Gate', 'lever', 'gate', 1, 'seed', NULL),
  ('gauntlet', 'Gauntlet', 'lever', 'gauntlet', 1, 'seed', NULL),
  ('gelato-digital', 'Gelato', 'workable', 'gelato-digital', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('gemini', 'Gemini', 'greenhouse', 'gemini', 1, 'seed', NULL),
  ('generalcatalyst', 'General Catalyst', 'greenhouse', 'generalcatalyst', 0, 'seed', 'disabled at seed: not crypto (venture firm, not a crypto employer)'),
  ('genies', 'Genies', 'ashby', 'genies', 1, 'seed', NULL),
  ('gensyn', 'Gensyn', 'greenhouse', 'gensyn', 1, 'seed', NULL),
  ('gnosis', 'Gnosis', 'personio', 'gnosis', 1, 'seed', NULL),
  ('goldsky', 'Goldsky', 'ashby', 'goldsky', 1, 'seed', NULL),
  ('gotenna-inc', 'goTenna', 'rippling', 'gotenna-inc', 0, 'seed', 'disabled at seed: not crypto (mesh networking hardware)'),
  ('grayscaleinvestments', 'Grayscale', 'greenhouse', 'grayscaleinvestments', 1, 'seed', NULL),
  ('gsrmarkets', 'GSR', 'greenhouse', 'gsrmarkets', 1, 'seed', NULL),
  ('hadronlabs', 'Neutron', 'teamtailor', 'hadronlabs', 1, 'getro:9035', 'found via getro:9035 (cyber.fund board, also delphi): its jobs link teamtailor:hadronlabs (2 open on 2026-09-14)'),
  ('halborn', 'Halborn', 'rippling', 'halborn', 1, 'seed', NULL),
  ('halborn-inc', 'Halborn', 'rippling', 'halborn-inc', 1, 'seed', NULL),
  ('halliday', 'Halliday', 'ashby', 'halliday', 1, 'seed', NULL),
  ('hang', 'Hang', 'ashby', 'hang', 1, 'seed', NULL),
  ('hashgraph', 'Hedera Hashgraph', 'ashby', 'hashgraph', 1, 'seed', NULL),
  ('helium', 'Nova Labs (Helium)', 'greenhouse', 'helium', 1, 'portfolio:a16z-crypto', 'listed on the public portfolio page https://a16zcrypto.com/portfolio/; company site https://nova.xyz/ careers page https://nova.xyz/ links greenhouse:helium (0 open on 2026-09-14)'),
  ('helius', 'Helius', 'ashby', 'helius', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('hexens', 'Hexens', 'bamboohr', 'hexens', 1, 'seed', NULL),
  ('hiro', 'Hiro', 'greenhouse', 'hiro', 1, 'seed', NULL),
  ('hivemapper', 'Hivemapper', 'lever', 'hivemapper', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('hivemind-capital', 'Hivemind Capital Partners', 'lever', 'hivemind-capital', 1, 'seed', NULL),
  ('hut8', 'Hut 8', 'greenhouse', 'hut8', 1, 'seed', NULL),
  ('hyperliquid-labs', 'Hyperliquid Labs', 'ashby', 'Hyperliquid%20Labs', 1, 'seed', NULL),
  ('immunefi', 'Immunefi', 'greenhouse', 'immunefi', 1, 'seed', NULL),
  ('immutable', 'Immutable Systems', 'lever', 'immutable', 1, 'seed', NULL),
  ('impossiblecloud', 'Impossible Cloud Network', 'lever', 'impossiblecloud', 1, 'portfolio:1kx', 'listed on the public portfolio page https://1kx.capital/portfolio; company site https://www.icn.global/ careers page https://www.icn.global/careers links lever:impossiblecloud (11 open on 2026-09-14)'),
  ('incadigitalinc', 'Inca Digital', 'greenhouse', 'incadigitalinc', 1, 'getro:9134', 'found via getro:9134 (Galaxy Ventures board, only there): the company careers page https://grnh.se/2vaoaexk9us links greenhouse:incadigitalinc (11 open on 2026-09-14)'),
  ('inco', 'Inco', 'bamboohr', 'inco', 1, 'seed', NULL),
  ('inference', 'Inference', 'ashby', 'inference', 1, 'seed', NULL),
  ('informal', 'Informal Systems', 'greenhouse', 'informal', 1, 'seed', NULL),
  ('infstones', 'InfStones', 'lever', 'infstones', 1, 'seed', NULL),
  ('injective', 'Injective Foundation', 'ashby', 'injective', 1, 'seed', NULL),
  ('injective-labs', 'Injective Labs', 'ashby', 'injective-labs', 1, 'seed', NULL),
  ('io-global', 'IO Global (IOG)', 'workable', 'io-global', 1, 'curated', 'Cardano ecosystem check 2026-09-14: iog.io/careers links apply.workable.com/io-global (board name ''IO Global'') (4 open on 2026-09-14)'),
  ('jito', 'Jito Labs', 'lever', 'jito', 1, 'seed', NULL),
  ('jito-labs', 'Jito Labs', 'ashby', 'jito-labs', 1, 'seed', NULL),
  ('jumpcrypto', 'Jump Crypto', 'greenhouse', 'jumpcrypto', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('jumptrading', 'Jump Crypto', 'greenhouse', 'jumptrading', 1, 'seed', NULL),
  ('kaiko', 'Kaiko', 'lever_eu', 'kaiko', 1, 'seed', NULL),
  ('kalshi', 'Kalshi', 'greenhouse', 'kalshi', 1, 'seed', NULL),
  ('kalshi-ashby', 'Kalshi', 'ashby', 'kalshi', 1, 'seed', NULL),
  ('keyrock', 'Keyrock', 'ashby', 'keyrock', 1, 'seed', NULL),
  ('kiln.fi', 'Kiln', 'ashby', 'kiln.fi', 1, 'getro:869', 'found via getro:869 (Blockchain Association board, only there): the company careers page https://www.kiln.fi/careers# links ashby:kiln.fi (0 open on 2026-09-14)'),
  ('kraken', 'Kraken', 'ashby', 'kraken', 1, 'seed', NULL),
  ('kraken.com', 'Kraken', 'ashby', 'kraken.com', 1, 'seed', NULL),
  ('kronosresearch', 'Kronos Research', 'greenhouse', 'kronosresearch', 1, 'seed', NULL),
  ('kwil', 'Kwil', 'breezy', 'kwil', 1, 'seed', NULL),
  ('layerzerolabs', 'LayerZero', 'greenhouse', 'layerzerolabs', 1, 'seed', NULL),
  ('ledger', 'Ledger', 'ashby', 'ledger', 1, 'seed', NULL),
  ('legend-xyz', 'Legend', 'ashby', 'legend-xyz', 1, 'portfolio:a16z-crypto', 'listed on the public portfolio page https://a16zcrypto.com/portfolio/; company site https://legend.xyz/ careers page https://legend.xyz/ links ashby:legend-xyz (2 open on 2026-09-14)'),
  ('li.fi', 'LI.FI', 'ashby', 'li.fi', 1, 'seed', NULL),
  ('lido', 'Lido', 'ashby', 'lido', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('lido.fi', 'Lido', 'ashby', 'lido.fi', 1, 'seed', NULL),
  ('lightning', 'Lightning Labs', 'ashby', 'lightning', 1, 'seed', NULL),
  ('lightspark', 'Lightspark', 'ashby', 'lightspark', 1, 'seed', NULL),
  ('limitbreak', 'Limit Break', 'lever', 'limitbreak', 1, 'seed', NULL),
  ('liquid', 'Liquid', 'ashby', 'liquid', 1, 'portfolio:paradigm', 'listed on the public portfolio page https://www.paradigm.xyz/investments; company site https://tryliquid.xyz/ careers page https://tryliquid.xyz/ links ashby:liquid (2 open on 2026-09-14)')
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('localcoin', 'Localcoin', 'greenhouse', 'localcoin', 1, 'curated', 'localcoinatm.com/careers links boards.greenhouse.io/localcoin (5 open on 2026-09-14); Bitcoin ATM operator'),
  ('logos', 'Logos', 'greenhouse', 'logos', 1, 'seed', NULL),
  ('luno', 'Luno', 'greenhouse', 'luno', 1, 'seed', NULL),
  ('luxor', 'Luxor Technology', 'ashby', 'luxor', 1, 'seed', NULL),
  ('m0dbathenextthingltd', 'M0', 'greenhouse', 'm0dbathenextthingltd', 1, 'seed', NULL),
  ('madhive', 'MadHive', 'ashby', 'madhive', 0, 'seed', 'disabled at seed: not crypto (TV advertising)'),
  ('magiceden', 'Magic Eden', 'ashby', 'magiceden', 1, 'seed', NULL),
  ('matter-labs', 'Matter Labs', 'ashby', 'matter-labs', 1, 'seed', NULL),
  ('meow', 'Meow', 'ashby', 'meow', 1, 'seed', NULL),
  ('merklescience', 'Merkle Science', 'lever', 'merklescience', 1, 'seed', NULL),
  ('mesh', 'Mesh', 'greenhouse', 'mesh', 1, 'seed', NULL),
  ('messari', 'Messari', 'greenhouse', 'messari', 1, 'seed', NULL),
  ('metawealth', 'MetaWealth', 'lever', 'metawealth', 1, 'seed', NULL),
  ('moderntreasury', 'Ansible Labs', 'ashby', 'moderntreasury', 1, 'seed', NULL),
  ('molecule', 'Molecule', 'ashby', 'molecule', 1, 'seed', NULL),
  ('monad', 'Monad', 'ashby', 'monad', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('monad.foundation', 'Monad Foundation', 'ashby', 'monad.foundation', 1, 'seed', NULL),
  ('moonpay', 'MoonPay', 'lever', 'moonpay', 1, 'seed', NULL),
  ('moonshot', 'Moonshot', 'ashby', 'moonshot', 1, 'seed', NULL),
  ('morpho', 'Morpho', 'ashby', 'morpho', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('mystenlabs', 'Mysten Labs', 'ashby', 'mystenlabs', 1, 'seed', NULL),
  ('n1', 'N1', 'ashby', 'n1', 1, 'seed', NULL),
  ('n3xt-jobs', 'N3xt', 'rippling', 'n3xt-jobs', 1, 'seed', NULL),
  ('nansen', 'Nansen', 'greenhouse', 'nansen', 1, 'seed', NULL),
  ('nearfoundation', 'NEAR Foundation', 'greenhouse', 'nearfoundation', 1, 'seed', NULL),
  ('nearone', 'NEAR One', 'greenhouse', 'nearone', 1, 'seed', NULL),
  ('nethermind', 'Nethermind', 'ashby', 'nethermind', 1, 'seed', NULL),
  ('nexo', 'Nexo', 'breezy', 'nexo', 1, 'seed', NULL),
  ('nexus', 'NEXUS', 'ashby', 'nexus', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('nexus.xyz', 'Nexus', 'ashby', 'nexus.xyz', 1, 'seed', NULL),
  ('niobium', 'Niobium Microsystems', 'bamboohr', 'niobium', 0, 'seed', 'disabled at seed: not crypto (encryption hardware)'),
  ('nomina', 'Omni Network', 'greenhouse', 'nomina', 1, 'seed', NULL),
  ('notabene', 'Notabene', 'ashby', 'notabene', 1, 'seed', NULL),
  ('o1-labs-operating-corporation', 'O(1) Labs', 'rippling', 'o1-labs-operating-corporation', 1, 'portfolio:paradigm', 'listed on the public portfolio page https://www.paradigm.xyz/investments; company site https://o1labs.org/ careers page https://o1labs.org/about-us links rippling:o1-labs-operating-corporation (0 open on 2026-09-14)'),
  ('offchainlabs', 'Offchain Labs', 'lever', 'offchainlabs', 1, 'seed', NULL),
  ('okx', 'OKX', 'greenhouse', 'okx', 1, 'seed', NULL),
  ('ondofinance', 'Ondo Finance', 'greenhouse', 'ondofinance', 1, 'seed', NULL),
  ('openfx', 'Openfx', 'greenhouse', 'openfx', 1, 'seed', NULL),
  ('opensea', 'OpenSea', 'ashby', 'opensea', 1, 'seed', NULL),
  ('openzeppelin', 'OpenZeppelin', 'greenhouse', 'openzeppelin', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('opfoundation', 'Optimism Foundation', 'ashby', 'opfoundation', 1, 'seed', NULL),
  ('oplabs', 'OP Labs', 'ashby', 'oplabs', 1, 'seed', NULL),
  ('optimum', 'Optimum', 'ashby', 'optimum', 1, 'portfolio:1kx', 'listed on the public portfolio page https://1kx.capital/portfolio; company site https://www.getoptimum.xyz/ careers page https://www.getoptimum.xyz/ links ashby:optimum (0 open on 2026-09-14)'),
  ('orca', 'Orca', 'ashby', 'orca', 1, 'seed', NULL),
  ('orderly', 'Orderly Network', 'greenhouse', 'orderly', 1, 'seed', NULL),
  ('osmosis', 'Osmosis', 'greenhouse', 'osmosis', 1, 'seed', NULL),
  ('oxio', 'OXIO', 'ashby', 'oxio', 0, 'seed', 'disabled at seed: not crypto (telecom)'),
  ('p2p.org', 'P2P.org', 'ashby', 'p2p.org', 1, 'seed', NULL),
  ('panteracapitalcareers', 'Pantera Capital', 'greenhouse', 'panteracapitalcareers', 1, 'seed', NULL),
  ('paradigm', 'Paradigm', 'ashby', 'paradigm', 1, 'seed', NULL),
  ('parity', 'Parity Technologies', 'ashby', 'parity', 1, 'seed', NULL),
  ('paxos', 'Paxos', 'ashby', 'paxos', 1, 'seed', NULL),
  ('paxoslabs', 'Paxos Labs', 'ashby', 'paxoslabs', 1, 'seed', NULL),
  ('phantom', 'Phantom', 'ashby', 'phantom', 1, 'seed', NULL),
  ('piplabs', 'PIP Labs', 'lever', 'piplabs', 1, 'seed', NULL),
  ('pixiongames', 'Pixion Games', 'teamtailor', 'pixiongames', 1, 'getro:1440', 'found via getro:1440 (Delphi Ventures board, only there): its jobs link teamtailor:pixiongames (3 open on 2026-09-14)'),
  ('plasma', 'Plasma', 'ashby', 'plasma', 1, 'seed', NULL),
  ('plume-network', 'Plume Network', 'rippling', 'plume-network', 1, 'seed', NULL),
  ('pluralfinance', 'Plural', 'ashby', 'pluralfinance', 1, 'seed', NULL),
  ('pluralis-research', 'Pluralis Research', 'ashby', 'pluralis-research', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('pod-network', 'pod', 'ashby', 'pod-network', 1, 'portfolio:1kx', 'listed on the public portfolio page https://1kx.capital/portfolio; company site https://pod.network/ careers page https://pod.network/ links ashby:pod-network (4 open on 2026-09-14)'),
  ('polychaincapital', 'Polychain', 'greenhouse', 'polychaincapital', 1, 'seed', NULL),
  ('polygon-labs', 'Polygon Labs', 'ashby', 'polygon-labs', 1, 'seed', NULL),
  ('polymarket', 'Polymarket', 'ashby', 'polymarket', 1, 'seed', NULL),
  ('possible-finance', 'Possible Finance', 'ashby', 'possible-finance', 0, 'seed', 'disabled at seed: not crypto (consumer lending)'),
  ('pqshield', 'PQShield', 'greenhouse', 'pqshield', 0, 'seed', 'disabled at seed: not crypto (post-quantum cryptography, not crypto assets)'),
  ('prestolabs', 'Presto Labs', 'lever', 'prestolabs', 1, 'seed', NULL),
  ('projecteleven', 'Project Eleven', 'ashby', 'projecteleven', 1, 'seed', NULL),
  ('provable', 'Provable', 'ashby', 'provable', 1, 'seed', NULL),
  ('public', 'Otis', 'greenhouse', 'public', 1, 'seed', NULL),
  ('puffer-finance', 'Puffer Finance', 'workable', 'puffer-finance', 1, 'portfolio:mechanism', 'listed on the public portfolio page https://www.mechanism.capital/portfolio; company site https://puffer.fi/ careers page https://puffer.fi/ links workable:puffer-finance (0 open on 2026-09-14)'),
  ('pythnetwork', 'Pyth Network', 'ashby', 'pythnetwork', 1, 'seed', NULL),
  ('qcp-group', 'QCP', 'workable', 'qcp-group', 1, 'seed', NULL),
  ('quantstamp', 'Quantstamp', 'ashby', 'quantstamp', 1, 'seed', NULL),
  ('quicknode', 'QuickNode', 'ashby', 'quicknode', 1, 'seed', NULL),
  ('radiant-industries', 'Radiant', 'ashby', 'radiant-industries', 1, 'seed', NULL),
  ('raiku', 'Raiku', 'ashby', 'raiku', 1, 'seed', NULL),
  ('rain', 'Rain', 'ashby', 'rain', 1, 'seed', NULL),
  ('rarible', 'Rarible', 'lever', 'rarible', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('rated-roles', 'Rated Labs', 'rippling', 'rated-roles', 1, 'getro:9035', 'found via getro:9035 (cyber.fund board, only there): its jobs link rippling:rated-roles (1 open on 2026-09-14)')
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('recall', 'Recall Network', 'greenhouse', 'recall', 1, 'seed', NULL),
  ('renegade', 'Renegade', 'lever', 'renegade', 1, 'seed', NULL),
  ('riot-platforms-careers', 'Riot Platforms', 'rippling', 'riot-platforms-careers', 1, 'seed', NULL),
  ('ripple', 'Ripple', 'greenhouse', 'ripple', 1, 'seed', NULL),
  ('risklabs', 'Across Protocol', 'ashby', 'risklabs', 1, 'seed', NULL),
  ('ritual', 'Ritual', 'greenhouse', 'ritual', 1, 'seed', NULL),
  ('river', 'River Financial', 'ashby', 'river', 1, 'seed', NULL),
  ('safe-labs', 'Safe Labs', 'personio', 'safe-labs', 1, 'seed', NULL),
  ('saga-xyz', 'Saga.xyz', 'lever', 'saga-xyz', 1, 'seed', NULL),
  ('sapiom', 'Sapiom', 'ashby', 'sapiom', 1, 'seed', NULL),
  ('sardine', 'Sardine', 'ashby', 'sardine', 1, 'seed', NULL),
  ('satoshilabs', 'SatoshiLabs', 'ashby', 'satoshilabs', 1, 'seed', NULL),
  ('securitize', 'Securitize', 'greenhouse', 'securitize', 1, 'seed', NULL),
  ('sei-labs', 'Sei Labs', 'ashby', 'sei-labs', 1, 'seed', NULL),
  ('seifoundation', 'Sei Labs', 'ashby', 'seifoundation', 1, 'seed', NULL),
  ('selinicapital', 'Selini Capital', 'greenhouse', 'selinicapital', 1, 'seed', NULL),
  ('sfcompute', 'San Francisco Compute Company', 'ashby', 'sfcompute', 0, 'seed', 'disabled at seed: not crypto (GPU compute)'),
  ('shakepay', 'Shakepay', 'greenhouse', 'shakepay', 1, 'seed', NULL),
  ('shapeways-25', 'Shapeways', 'workable', 'shapeways-25', 0, 'seed', 'disabled at seed: not crypto (3D printing)'),
  ('sigp', 'Sigma Prime', 'ashby', 'sigp', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('simscale', 'SimScale', 'greenhouse', 'simscale', 0, 'seed', 'disabled at seed: not crypto (engineering simulation software)'),
  ('simulmedia', 'Simulmedia', 'lever', 'simulmedia', 0, 'seed', 'disabled at seed: not crypto (TV advertising)'),
  ('skyecosystem', 'Sky Frontier Foundation', 'ashby', 'skyecosystem', 1, 'seed', NULL),
  ('skymavis', 'Sky Mavis', 'ashby', 'skymavis', 1, 'seed', NULL),
  ('socket', 'Socket', 'greenhouse', 'socket', 1, 'seed', NULL),
  ('sofarsounds', 'Sofar Sounds', 'lever', 'sofarsounds', 0, 'seed', 'disabled at seed: not crypto (live music events)'),
  ('solana', 'Solana Foundation', 'ashby', 'solana', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('solana-foundation', 'Solana Foundation', 'ashby', 'Solana%20Foundation', 1, 'getro:858', 'found via getro:858 (Solana board, also jump-crypto): its jobs link ashby:Solana%20Foundation (6 open on 2026-09-14); the same company is in the registry only with a disabled board; the same company is in the registry only with a disabled board'),
  ('solanalabs', 'Solana Labs', 'ashby', 'solanalabs', 1, 'seed', NULL),
  ('solflare', 'Solflare', 'smartrecruiters', 'solflare', 1, 'seed', NULL),
  ('sorare', 'Sorare', 'ashby', 'sorare', 1, 'seed', NULL),
  ('sorellalabs', 'Sorella Labs', 'greenhouse', 'sorellalabs', 1, 'seed', NULL),
  ('sound', 'Sound', 'ashby', 'sound', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('sound.xyz', 'Sound', 'ashby', 'sound.xyz', 1, 'seed', NULL),
  ('sovrun', 'Sovrun', 'workable', 'sovrun', 1, 'portfolio:a16z-crypto', 'listed on the public portfolio page https://a16zcrypto.com/portfolio/ (also mechanism); company site https://www.sovrun.org/ careers page https://www.sovrun.org/ links workable:sovrun (0 open on 2026-09-14)'),
  ('spectral', 'Spectral', 'lever', 'spectral', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('sphere', 'Sphere', 'ashby', 'sphere', 1, 'seed', NULL),
  ('sphere-laboratories', 'Sphere', 'lever', 'sphere-laboratories', 1, 'seed', NULL),
  ('spruceid', 'Spruce Systems', 'ashby', 'spruceid', 1, 'seed', NULL),
  ('squads', 'Squads', 'ashby', 'squads', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('stargate-foundation', 'Stargate', 'ashby', 'stargate-foundation', 1, 'seed', NULL),
  ('starknetfoundation', 'Starknet Foundation', 'ashby', 'starknetfoundation', 1, 'seed', NULL),
  ('startale', 'Astar Foundation', 'greenhouse', 'startale', 1, 'seed', NULL),
  ('stellar', 'Stellar Development Foundation', 'ashby', 'stellar', 1, 'seed', NULL),
  ('stork', 'Stork Labs', 'ashby', 'stork', 1, 'seed', NULL),
  ('strike', 'Strike', 'greenhouse', 'strike', 1, 'seed', NULL),
  ('stronghold', 'Stronghold', 'ashby', 'stronghold', 1, 'seed', NULL),
  ('succinct', 'Succinct', 'ashby', 'succinct', 1, 'seed', NULL),
  ('sui', 'Sui Foundation', 'ashby', 'sui', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('sui-foundation', 'Sui Foundation', 'ashby', 'Sui%20Foundation', 1, 'seed', NULL),
  ('superstate', 'Superstate', 'lever', 'superstate', 1, 'seed', NULL),
  ('sweatcoin', 'Sweatcoin', 'teamtailor', 'sweatcoin', 1, 'getro:1640', 'found via getro:1640 (Electric Capital board, only there): its jobs link teamtailor:sweatcoin (2 open on 2026-09-14)'),
  ('symbiotic', 'Symbiotic', 'ashby', 'symbiotic', 1, 'seed', NULL),
  ('syndica', 'Syndica', 'ashby', 'syndica', 1, 'seed', NULL),
  ('szns', 'SZNS', 'workable', 'szns', 1, 'seed', NULL),
  ('talos-trading', 'Talos', 'ashby', 'talos-trading', 1, 'seed', NULL),
  ('tastylive', 'tastylive', 'greenhouse', 'tastylive', 1, 'curated', 'tastylive.com/careers links boards.greenhouse.io/tastylive (15 open on 2026-09-14); listed by web3.career'),
  ('taxbit', 'TaxBit', 'greenhouse', 'taxbit', 1, 'seed', NULL),
  ('tempo-xyz', 'Tempo', 'ashby', 'tempo-xyz', 1, 'seed', NULL),
  ('tenderly', 'Tenderly', 'ashby', 'tenderly', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('tether', 'Tether', 'recruitee', 'tether', 1, 'seed', NULL),
  ('the-metaplex-foundation', 'Metaplex', 'workable', 'the-metaplex-foundation', 1, 'seed', NULL),
  ('toku', 'Toku', 'lever', 'toku', 1, 'seed', NULL),
  ('tools', 'World', 'ashby', 'tools', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('tools-for-humanity', 'Tools for Humanity', 'ashby', 'Tools%20for%20Humanity', 1, 'seed', NULL),
  ('trailofbits', 'Trail of Bits', 'workable', 'trailofbits', 1, 'seed', NULL),
  ('transak-inc', 'Transak', 'breezy', 'transak-inc', 1, 'seed', NULL),
  ('trm-labs', 'TRM Labs', 'ashby', 'trm-labs', 1, 'seed', NULL),
  ('turnkey', 'Turnkey', 'ashby', 'turnkey', 1, 'seed', NULL),
  ('turnkeycareers', 'Turnkey', 'greenhouse', 'turnkeycareers', 1, 'seed', NULL),
  ('unchained', 'Unchained', 'rippling', 'unchained', 1, 'seed', NULL),
  ('uniswap', 'Uniswap Labs', 'ashby', 'uniswap', 1, 'seed', NULL),
  ('uniswapfoundation', 'Uniswap Foundation', 'greenhouse', 'uniswapfoundation', 1, 'seed', NULL),
  ('unto-labs', 'Unto Labs', 'ashby', 'unto-labs', 1, 'seed', NULL),
  ('uphold', 'Uphold', 'bamboohr', 'uphold', 1, 'seed', NULL),
  ('valinor', 'Valinor', 'workable', 'valinor', 1, 'seed', NULL),
  ('valorainc', 'Valora', 'greenhouse', 'valorainc', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('veda', 'Veda', 'ashby', 'veda', 1, 'seed', NULL),
  ('veefriends-llc', 'VeeFriends', 'rippling', 'veefriends-llc', 1, 'seed', NULL),
  ('velocity', 'Velocity', 'ashby', 'velocity', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('veniceai', 'Venice', 'greenhouse', 'veniceai', 1, 'seed', NULL),
  ('ventuals', 'Ventuals', 'ashby', 'ventuals', 1, 'seed', NULL),
  ('veremark', 'Veremark', 'smartrecruiters', 'veremark', 1, 'seed', NULL),
  ('via99', 'VIA', 'greenhouse', 'via99', 1, 'seed', NULL),
  ('walletconnect', 'WalletConnect', 'workable', 'walletconnect', 1, 'seed', NULL),
  ('walrus', 'Walrus Foundation', 'ashby', 'walrus', 1, 'seed', NULL),
  ('waterfall', 'Waterfall', 'lever', 'waterfall', 1, 'seed', NULL),
  ('web3', 'Kusama', 'bamboohr', 'web3', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('windranger', 'HyperPlay', 'ashby', 'windranger', 1, 'seed', NULL),
  ('wintermute-trading', 'Wintermute', 'lever', 'wintermute-trading', 1, 'seed', NULL),
  ('woo', 'WOO Network', 'greenhouse', 'woo', 1, 'seed', NULL),
  ('world-foundation', 'World Foundation', 'ashby', 'world-foundation', 1, 'seed', NULL),
  ('wormholelabs', 'Wormhole', 'ashby', 'wormholelabs', 1, 'seed', NULL),
  ('wynd-labs', 'Wynd Network', 'ashby', 'wynd-labs', 1, 'seed', NULL),
  ('xapo61', 'Xapo', 'greenhouse', 'xapo61', 1, 'seed', NULL),
  ('xmtp', 'XMTP', 'ashby', 'xmtp', 0, 'seed', 'disabled at seed: the ATS board did not answer on 2026-09-14'),
  ('xpansiv', 'Xpansiv', 'lever', 'xpansiv', 0, 'seed', 'disabled at seed: not crypto (environmental commodities)'),
  ('yellowcard', 'Yellow Card', 'bamboohr', 'yellowcard', 1, 'seed', NULL),
  ('yieldmo', 'Yieldmo', 'greenhouse', 'yieldmo', 0, 'seed', 'disabled at seed: not crypto (advertising)'),
  ('zerion', 'Zerion', 'lever', 'zerion', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('zero-hash', 'Zero Hash', 'breezy', 'zero-hash', 1, 'seed', NULL),
  ('zircuit', 'Zircuit', 'ashby', 'Zircuit', 1, 'portfolio:robot-ventures', 'listed on the public portfolio page https://robvc.com/; company site https://www.zircuit.com/ careers page https://www.zircuit.com/ links ashby:Zircuit (0 open on 2026-09-14)'),
  ('zodl', 'Zcash Open Development Lab (ZODL)', 'ashby', 'zodl', 1, 'seed', NULL)
  ON CONFLICT DO NOTHING;
INSERT OR IGNORE INTO schema_migrations(name) VALUES ('seed_registry');
