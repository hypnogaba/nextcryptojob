-- NextCryptoJob, доріжка web: одна картка на людину (раунд 5, п.7). Досі активна картка була
-- одна на (людина, роль): людина з кількома ролями мала кілька карток одночасно ("Cards 2" в
-- Overview; власник побачив Community 51 і Marketing 50 разом). Тепер картка одна на людину:
-- роль = головна роль, яку людина обрала першою в брифі (users.roles[0]), або найвищий бал серед
-- її активних карток, якщо картки головної ролі нема. Стару адресу /c/<slug> прибраної картки
-- веде на ту, що лишилась (redirect_to, web/src/app/c/[slug]/page.tsx).
-- Спирається на cards з 0005_cards. Накочує controller, не доріжка, ДО деплою коду, що спирається
-- на єдиний індекс (createCard, web/src/lib/card/store.ts).

-- Без REFERENCES навмисно: слово redirect_to старої картки і вставка нової йдуть в одному batch,
-- і new slug ще не існує в момент UPDATE (перед INSERT), а FK перевіряється негайно. Значення
-- завжди дійсний slug наступного INSERT у тій самій транзакції (createCard, web/src/lib/card/store.ts).
ALTER TABLE cards ADD COLUMN redirect_to TEXT;

-- Дані: людям із понад однією активною карткою лишаємо одну (головна роль, інакше найвищий бал,
-- за рівних балів найновіша), решту відкликаємо й ведемо на ту, що лишилась. Без CTE й віконних
-- функцій навмисно: лише корельовані підзапити з ORDER BY + LIMIT 1, сумісні з будь-якою SQLite.
UPDATE cards
   SET revoked_at  = datetime('now'),
       redirect_to = (
         SELECT keep.slug FROM cards keep
          WHERE keep.user_id = cards.user_id AND keep.revoked_at IS NULL
          ORDER BY
            CASE WHEN keep.role = (SELECT json_extract(u.roles, '$[0]') FROM users u WHERE u.id = keep.user_id)
                 THEN 0 ELSE 1 END,
            keep.score DESC,
            keep.created_at DESC
          LIMIT 1
       )
 WHERE cards.revoked_at IS NULL
   AND cards.slug <> (
         SELECT keep.slug FROM cards keep
          WHERE keep.user_id = cards.user_id AND keep.revoked_at IS NULL
          ORDER BY
            CASE WHEN keep.role = (SELECT json_extract(u.roles, '$[0]') FROM users u WHERE u.id = keep.user_id)
                 THEN 0 ELSE 1 END,
            keep.score DESC,
            keep.created_at DESC
          LIMIT 1
       );

-- Індекс: активна картка одна на людину (було на людину+роль, idx_cards_active з 0005_cards).
DROP INDEX IF EXISTS idx_cards_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_active_user ON cards(user_id) WHERE revoked_at IS NULL;

-- Лідерборд (раунд 5, п.7): усі з публічною карткою, за балом. За замовчуванням видима (як
-- решта картки: /c/<slug> вже публічна сторінка), можна вимкнути в /settings, Privacy.
ALTER TABLE users ADD COLUMN card_public INTEGER NOT NULL DEFAULT 1 CHECK (card_public IN (0, 1));

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0024_one_card_per_person');
