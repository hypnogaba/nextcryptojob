-- 17.09.2026, другий захід: компанії з відкритими дошками, знайдені за списком DefiLlama (TVL > $1 млн)
-- і за назвами, яких не вгадав перший захід. Шлях у кожного: сайт компанії → сторінка кар'єри → публічний ATS.
INSERT OR IGNORE INTO companies (slug,name,ats_provider,ats_slug,enabled,discovered_via,note) VALUES
 ('greenhouse:galaxydigitalservices','Galaxy Digital Services','greenhouse','galaxydigitalservices',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS'),
 ('greenhouse:orderly','Orderly Network','greenhouse','orderly',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS'),
 ('ashby:phantom','Phantom','ashby','phantom',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS'),
 ('greenhouse:layerzerolabs','LayerZero Labs','greenhouse','layerzerolabs',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS'),
 ('greenhouse:dialecticch','Dialectic','greenhouse','dialecticch',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS'),
 ('lever:immutable','Immutable','lever','immutable',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS'),
 ('lever:swissborg','SwissBorg','lever','swissborg',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS'),
 ('personio:gnosis','Gnosis','personio','gnosis',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS'),
 ('gem:arcus','Arcus','gem','arcus',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS'),
 ('lever:superstate','Superstate','lever','superstate',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS'),
 ('ashby:Arrakis','Arrakis Finance','ashby','Arrakis',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS'),
 ('greenhouse:makina','Makina','greenhouse','makina',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS'),
 ('greenhouse:woo','WOO X','greenhouse','woo',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS'),
 ('ashby:eigen-labs','Eigen Labs','ashby','eigen-labs',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS'),
 ('ashby:steakhouse','Steakhouse Financial','ashby','steakhouse',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS'),
 ('ashby:risklabs','Risk Labs','ashby','risklabs',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS'),
 ('greenhouse:eclipse','Eclipse','greenhouse','eclipse',1,'defillama-2026-09-17','сайт компанії зі списку DefiLlama → сторінка кар''єри → ATS');

-- Ті, кого не вгадав перший захід слага (Ondo → ondofinance тощо).
INSERT OR IGNORE INTO companies (slug,name,ats_provider,ats_slug,enabled,discovered_via,note) VALUES
 ('greenhouse:ondofinance','Ondo','greenhouse','ondofinance',1,'recover-ats-2026-09-17','повернення після закриття board:jobstash'),
 ('workable:fasanara','Fasanara Capital','workable','fasanara',1,'recover-ats-2026-09-17','повернення після закриття board:jobstash'),
 ('ashby:alpenlabs','Alpen','ashby','alpenlabs',1,'recover-ats-2026-09-17','повернення після закриття board:jobstash'),
 ('workable:deltaexchange','Delta Exchange','workable','deltaexchange',1,'recover-ats-2026-09-17','повернення після закриття board:jobstash'),
 ('workable:fortytwo','FortyTwo','workable','fortytwo',1,'recover-ats-2026-09-17','повернення після закриття board:jobstash'),
 ('ashby:binance.us','Binance US','ashby','binance.us',1,'coingecko-2026-09-17','біржа зі списку CoinGecko, сайт → сторінка кар''єри → ATS');
