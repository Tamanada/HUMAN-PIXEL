import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { must, rpc, supabase } from '../../lib/supabase';
import type { AreaRow, EventRow, FormationRow } from '../../lib/types';

export function useEvent(eventId: string) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['event', eventId],
    queryFn: async () => must(await supabase.from('events').select('*').eq('id', eventId).single()) as EventRow,
  });
  // Realtime: state changes made by co-organizers or the scheduler (RLS-filtered).
  useEffect(() => {
    const ch = supabase
      .channel(`event:${eventId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'events', filter: `id=eq.${eventId}` }, (payload) => {
        qc.setQueryData(['event', eventId], (old: EventRow | undefined) => (old ? { ...old, ...(payload.new as EventRow) } : old));
      })
      .subscribe();
    return () => void supabase.removeChannel(ch);
  }, [eventId, qc]);
  return q;
}

export function useAreas(eventId: string) {
  return useQuery({
    queryKey: ['areas', eventId],
    queryFn: () => rpc<AreaRow[]>('get_event_areas', { p_event_id: eventId }),
  });
}

export function useFormations(eventId: string) {
  return useQuery({
    queryKey: ['formations', eventId],
    queryFn: async () =>
      must(
        await supabase
          .from('formations')
          .select('id, event_id, version, status, source, params, seed, point_count, uploaded_count, metrics, warnings, validation, created_at, locked_at')
          .eq('event_id', eventId)
          .order('version', { ascending: false }),
      ) as FormationRow[],
  });
}

export interface ColumnarPoints {
  idx: number[];
  lat: number[];
  lng: number[];
  x: number[];
  y: number[];
  zone: number[];
  rank: number[];
}

export function useFormationPoints(formationId: string | null | undefined) {
  return useQuery({
    queryKey: ['formation-points', formationId],
    enabled: !!formationId,
    staleTime: Infinity,
    queryFn: () => rpc<ColumnarPoints>('get_formation_points', { p_formation_id: formationId }),
  });
}

export function useCounters(eventId: string) {
  return useQuery({
    queryKey: ['counters', eventId],
    refetchInterval: 15_000,
    queryFn: async () => must(await supabase.from('event_counters').select('registered, next_participant_number').eq('event_id', eventId).single()) as { registered: number; next_participant_number: number },
  });
}
