-- Re-derive merchant_norm for descriptions carrying an apostrophe.
--
-- The first backfill blanked an apostrophe like any other punctuation mark, so
-- "Macy's" became 'macy s' — two words, one of them a single letter that the
-- matcher throws away, leaving 'macy' to be compared against the bank's
-- 'macys'. Deleting the apostrophe instead keeps the possessive in one piece.
-- merchant_norm is derived data: recomputing it changes no transaction.

update transactions
   set merchant_norm = trim(
     regexp_replace(
       regexp_replace(
         regexp_replace(
           regexp_replace(
             regexp_replace(lower(description), '[''‘’`]', '', 'g'),
             '\m(card|carte)\s*[0-9]+', ' ', 'g'
           ),
           '\m(pos|pin|ach|dbt|dda|debit|credit|purchase|payment|paiement|txn|trn|ref|xxx+)\M',
           ' ',
           'g'
         ),
         '[^a-z ]+', ' ', 'g'
       ),
       '\s+', ' ', 'g'
     )
   )
 where description ~ '[''‘’`]';
