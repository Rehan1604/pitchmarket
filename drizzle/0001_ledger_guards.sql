-- Immutable ledgers: trades, cash entries and price history can be appended to,
-- never rewritten. Account deletion anonymises users instead of deleting rows.
CREATE OR REPLACE FUNCTION pitchmarket_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (attempted %)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trades_immutable BEFORE UPDATE OR DELETE ON "trades"
  FOR EACH ROW EXECUTE FUNCTION pitchmarket_block_mutation();
--> statement-breakpoint
CREATE TRIGGER cash_entries_immutable BEFORE UPDATE OR DELETE ON "cash_entries"
  FOR EACH ROW EXECUTE FUNCTION pitchmarket_block_mutation();
--> statement-breakpoint
CREATE TRIGGER price_ticks_immutable BEFORE UPDATE OR DELETE ON "price_ticks"
  FOR EACH ROW EXECUTE FUNCTION pitchmarket_block_mutation();
--> statement-breakpoint
INSERT INTO "market_state" ("id", "version", "status", "data_mode") VALUES (1, 0, 'open', 'none')
  ON CONFLICT ("id") DO NOTHING;
