import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, must } from './supabase';

export type OrgRole = 'owner' | 'admin' | 'member';

export interface Membership {
  org_id: string;
  role: OrgRole;
  organizations: { id: string; name: string; slug: string; status: 'active' | 'suspended' };
}

export interface Profile {
  id: string;
  display_name: string | null;
  platform_role: 'user' | 'admin';
  is_suspended: boolean;
}

interface AuthState {
  session: Session | null;
  loading: boolean;
  profile: Profile | null;
  memberships: Membership[];
  isAdmin: boolean;
  refresh: () => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      void qc.invalidateQueries();
    });
    return () => data.subscription.unsubscribe();
  }, [qc]);

  const uid = session?.user.id;
  const profile = useQuery({
    queryKey: ['profile', uid],
    enabled: !!uid,
    queryFn: async () => must(await supabase.from('profiles').select('id, display_name, platform_role, is_suspended').eq('id', uid!).single()) as Profile,
  });
  const memberships = useQuery({
    queryKey: ['memberships', uid],
    enabled: !!uid,
    queryFn: async () =>
      must(await supabase.from('organization_members').select('org_id, role, organizations(id, name, slug, status)').eq('user_id', uid!)) as unknown as Membership[],
  });

  const value: AuthState = {
    session,
    loading: loading || (!!uid && (profile.isLoading || memberships.isLoading)),
    profile: profile.data ?? null,
    memberships: memberships.data ?? [],
    isAdmin: profile.data?.platform_role === 'admin',
    refresh: () => {
      void profile.refetch();
      void memberships.refetch();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

export function canManage(m: Membership | undefined, isAdmin: boolean): boolean {
  return isAdmin || m?.role === 'owner' || m?.role === 'admin';
}
