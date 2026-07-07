-- Tag legacy aforo_history JSON rows with transactionId when there is only one
-- possible facility for the client. Multi-facility clients keep untagged rows as
-- general fallback so history is not assigned to the wrong credit.

WITH single_facility_clients AS (
  SELECT client_id, MIN(id)::text AS transaction_id
  FROM transactions
  GROUP BY client_id
  HAVING COUNT(*) = 1
),
rewritten AS (
  SELECT
    c.id,
    jsonb_agg(
      CASE
        WHEN jsonb_typeof(item.value) = 'object'
          AND NOT (item.value ? 'transactionId')
          AND NOT (item.value ? 'transaction_id')
        THEN item.value || jsonb_build_object('transactionId', s.transaction_id)
        ELSE item.value
      END
      ORDER BY item.ordinality
    ) AS aforo_history
  FROM clients c
  JOIN single_facility_clients s ON s.client_id = c.id
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.aforo_history, '[]'::jsonb)) WITH ORDINALITY AS item(value, ordinality)
  WHERE jsonb_typeof(COALESCE(c.aforo_history, '[]'::jsonb)) = 'array'
  GROUP BY c.id
)
UPDATE clients c
SET aforo_history = rewritten.aforo_history
FROM rewritten
WHERE c.id = rewritten.id;
