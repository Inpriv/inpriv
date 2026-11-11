-- The unsubscribe target this message offers, parsed from the List-Unsubscribe
-- header at delivery (before the body is encrypted) and stored server-side, so
-- the endpoint never has to trust a client-supplied URL or address.
ALTER TABLE messages ADD COLUMN unsubscribe TEXT;
