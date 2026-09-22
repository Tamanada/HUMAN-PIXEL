-- PARTICIPANT BRIEFING + PICKUP POINTS
--
-- Two needs of a sponsored event: tell people what to wear / bring / collect, and hand out
-- thousands of t-shirts (or drinks, or a post-event bounty) without a stampede at one table.
--
-- • events.briefing (jsonb): dress code with colour swatches, what to bring, what to collect,
--   the bounty after the event. Public: shown before joining and on the phone.
-- • Pickup points are event areas of three new kinds (collection / control / bounty) with opening
--   hours, a capacity and what they hand out.
-- • Every participant is assigned ONE collection point at join time, the least loaded one, so the
--   queues and the stock split evenly. Organizers can move somebody to another point.

alter type public.area_kind add value if not exists 'collection';
alter type public.area_kind add value if not exists 'control';
alter type public.area_kind add value if not exists 'bounty';
