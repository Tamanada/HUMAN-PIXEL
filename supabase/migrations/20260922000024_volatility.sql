-- ---------------------------------------------------------------------------------------------
-- VOLATILITY MARKINGS — the `supabase db lint` gate.
--
-- plpgsql_check reports "routine is marked as STABLE, but expression is VOLATILE", and it is right
-- to: a STABLE routine promises not to change the database and to stay consistent within one
-- statement, so a STABLE routine calling a VOLATILE expression means one of the two markings is a
-- lie. Thirteen of these had CI red since its very first run — unnoticed because the local stack
-- ships without plpgsql_check, so `supabase db lint` silently passes on a developer machine.
--
-- Two honest corrections, no behaviour change:
--
--   • hp_forbid() only raises an exception. It reads nothing and writes nothing, so STABLE is the
--     truth — and that single line clears nine of the warnings, because every guarded read calls it.
--
--   • get_event_live_stats and get_my_assignment genuinely read the wall clock: the first measures
--     its own latency for the health panel, the second returns the server_time the phones
--     synchronise on. clock_timestamp() must stay, so VOLATILE is the truth for them.
--
-- Both are only ever reached through supabase.rpc(), which POSTs, so PostgREST (which restricts
-- volatile routines to POST) serves them exactly as before.
-- ---------------------------------------------------------------------------------------------

alter function public.hp_forbid() stable;
alter function public.get_event_live_stats(uuid) volatile;
alter function public.get_my_assignment(uuid) volatile;
