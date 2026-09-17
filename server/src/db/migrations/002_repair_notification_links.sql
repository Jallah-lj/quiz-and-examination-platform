-- Repairs notification links that pointed at a retired /student prefix.
--
-- Candidates have no /student/* routes, so "Open" on one of these notifications landed
-- on the not-found page. The prefix is dropped so the link resolves to the shared page,
-- which renders the candidate view for that role.
--
-- Earlier releases of the seed and the notification services wrote these paths, so rows
-- already stored in an existing database need the same repair as the code.

UPDATE notifications
   SET link = substr(link, 9)
 WHERE link LIKE '/student/%';
