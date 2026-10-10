import React, { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useGetMobileAccount } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useSession } from '@/lib/session';

export function usd(value: string | null) {
  if (value === null) return 'Unavailable';
  // Display decimal strings directly, without converting ledger money to a JS number.
  const [whole, fraction = ''] = value.split('.');
  return `${whole.startsWith('-') ? '-' : ''}$${whole.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.padEnd(2, '0')}`;
}
export default function AccountScreen({ section }: { section: 'Overview' | 'Positions' | 'Activity' }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const [cursor, setCursor] = useState<string | undefined>();
  const [pages, setPages] = useState<(string | undefined)[]>([]);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const query = useGetMobileAccount(cursor ? { cursor } : undefined, {
    query: { queryKey: ['mobile-account', cursor ?? 'first'], retry: false, staleTime: 15000, refetchOnWindowFocus: true },
    request: { credentials: 'omit' },
  });
  const data = query.data;
  const status = (query.error as { status?: number } | null)?.status;
  useEffect(() => { if (status === 401) void session.expire(); }, [status]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => { if (state === 'active') void query.refetch(); });
    return () => listener.remove();
  }, [query.refetch]);
  const text = { color: c.foreground };
  const muted = { color: c.mutedForeground };
  const card = [styles.card, { backgroundColor: c.card, borderColor: c.border }];
  const button = [styles.button, { backgroundColor: c.secondary }];
  return <ScrollView style={{ flex: 1, backgroundColor: c.background }}
    contentContainerStyle={{ paddingHorizontal: 22, paddingTop: (Platform.OS === 'web' ? 67 : insets.top) + 18, paddingBottom: 120, gap: 20 }}
    refreshControl={<RefreshControl refreshing={query.isFetching && !query.isLoading} onRefresh={() => void query.refetch()} tintColor={c.primary} />}>
    <View style={styles.row}><View><Text style={[styles.brand, { color: c.primary }]}>BALTIMORE CAPITAL</Text><Text style={[styles.title, text]}>{section}</Text></View>
      <View style={styles.row}>
      <Pressable accessibilityLabel="Refresh account" testID="refresh-account" disabled={query.isFetching} onPress={() => void query.refetch()} style={button}>
        {query.isFetching ? <ActivityIndicator color={c.primary} /> : <Feather name="refresh-cw" size={20} color={c.primary} />}
      </Pressable>
      <Pressable accessibilityLabel="Sign out" testID="sign-out" disabled={leaving} onPress={async () => {
        setLeaving(true); setLogoutError(null);
        try { await session.signOut(); } catch { setLogoutError('Sign-out could not reach the server. Retry to revoke this session.'); }
        finally { setLeaving(false); }
      }} style={button}>{leaving ? <ActivityIndicator color={c.primary} /> : <Feather name="log-out" size={20} color={c.mutedForeground} />}</Pressable>
      </View>
    </View>
    {logoutError && <Text accessibilityRole="alert" style={{ color: c.destructive }}>{logoutError}</Text>}
    {query.isLoading && <ActivityIndicator size="large" color={c.primary} />}
    {query.isError && <View style={card}><Text style={[styles.subtitle, text]}>Account data unavailable</Text><Text style={muted}>We couldn’t verify your latest account information. No balances are shown while the request is failing.</Text><Pressable testID="retry-account" style={button} onPress={() => void query.refetch()}><Text style={text}>Try again</Text></Pressable></View>}
    {data && !query.isError && <>
      {section === 'Overview' && <>
        <View><Text style={[styles.subtitle, text]}>{data.user.fullName}</Text><Text style={[styles.body, muted]}>{data.user.email}</Text></View>
        <View style={[...card, { borderColor: c.primary }]}>
          <Text style={[styles.label, muted]}>TOTAL EQUITY · USD</Text>
          <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.balance, text]}>{usd(data.wallet.equityUsd)}</Text>
          <Text style={[styles.body, muted]}>Ledger-derived account value</Text>
        </View>
        <View style={card}>{([
          ['Available', data.wallet.availableUsd], ['Deployed capital', data.wallet.deployedUsd], ['Pending withdrawals', data.wallet.pendingWithdrawalsUsd],
        ] as const).map(([label, value]) => <View key={label} style={styles.row}><Text style={[styles.body, muted]}>{label}</Text><Text style={[styles.value, text]}>{usd(value)}</Text></View>)}</View>
        <View style={card}><View style={styles.row}><Text style={[styles.subtitle, text]}>Account status</Text><Feather name="shield" size={20} color={c.primary} /></View><Text style={[styles.body, muted]}>Identity verification: {data.user.kycStatus.replaceAll('_', ' ')}</Text><Text style={[styles.body, muted]}>Execution: {data.executionMode === 'internal' ? 'Internal — platform is the counterparty; no broker orders' : 'Broker'}</Text></View>
      </>}
      {section === 'Positions' && <>
        <Text style={[styles.body, muted]}>Stored positions · read only</Text>
        <View style={card}><Text style={[styles.body, muted]}>{data.market}</Text></View>
        {data.positions.length === 0 && <View style={card}><Feather name="layers" size={26} color={c.primary} /><Text style={[styles.subtitle, text]}>No positions yet</Text><Text style={[styles.body, muted]}>Positions belonging to your account will appear here when available.</Text></View>}
        {data.positions.map(p => <View key={p.id} style={card}>
          <View style={styles.row}><Text style={[styles.subtitle, text]}>{p.symbol}</Text><Text style={{ color: c.primary }}>{p.status}</Text></View>
          <Text style={[styles.body, muted]}>{p.side} · {new Date(p.openedAt).toLocaleString()}</Text>
          {p.stake !== null && <View style={styles.row}><Text style={muted}>Stake</Text><Text style={text}>{usd(p.stake)}</Text></View>}
          <View style={styles.row}><Text style={muted}>Entry price</Text><Text style={text}>{p.entryPrice}</Text></View>
          <View style={styles.row}><Text style={muted}>Stored price</Text><Text style={text}>{p.currentPrice ?? 'Unavailable'}</Text></View>
          <View style={styles.row}><Text style={muted}>{p.status === 'OPEN' ? 'Recorded P/L' : 'Realized P/L'}</Text><Text style={[styles.value, text]}>{usd(p.pnl)}</Text></View>
        </View>)}
        <View style={styles.row}>
          {pages.length > 0 && <Pressable testID="previous-positions" style={button} onPress={() => { setCursor(pages[pages.length - 1]); setPages(p => p.slice(0, -1)); }}><Text style={text}>Previous</Text></Pressable>}
          {data.nextCursor && <Pressable testID="next-positions" style={button} onPress={() => { setPages(p => [...p, cursor]); setCursor(data.nextCursor!); }}><Text style={text}>Next positions</Text></Pressable>}
        </View>
      </>}
      {section === 'Activity' && <>
        <Text style={[styles.body, muted]}>Latest 50 account events</Text>
        {data.activity.length === 0 && <View style={card}><Feather name="clock" size={26} color={c.primary} /><Text style={[styles.subtitle, text]}>No account activity</Text><Text style={[styles.body, muted]}>Only recorded account events appear here.</Text></View>}
        {data.activity.map(event => <View key={event.id} style={card}><Text style={[styles.label, { color: event.severity === 'error' ? c.destructive : c.primary }]}>{event.severity.toUpperCase()}</Text><Text style={[styles.body, text]}>{event.message}</Text><Text style={[styles.small, muted]}>{new Date(event.createdAt).toLocaleString()}</Text></View>)}
      </>}
      {section === 'Overview' && <View style={card}><Text style={[styles.subtitle, text]}>Service availability</Text><Text style={[styles.body, muted]}>{data.payments}</Text><Text style={[styles.body, muted]}>{data.market}</Text></View>}
      <Text style={[styles.small, muted]}>Updated {new Date(data.updatedAt).toLocaleString()} · {Platform.OS === 'web' ? 'Tap refresh to update' : 'Pull or tap to refresh'}{'\n'}Read-only companion. No trading or payments can be submitted.</Text>
    </>}
  </ScrollView>;
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  brand: { fontFamily: 'Inter_700Bold', fontSize: 12, letterSpacing: 3, marginBottom: 8 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 28 },
  subtitle: { fontFamily: 'Inter_600SemiBold', fontSize: 17 },
  card: { padding: 20, borderWidth: 1, borderRadius: 8, gap: 16 },
  label: { fontFamily: 'Inter_600SemiBold', fontSize: 11, letterSpacing: 1.3 },
  balance: { fontFamily: 'Inter_600SemiBold', fontSize: 38, marginVertical: 3 },
  body: { fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 22 },
  value: { fontFamily: 'Inter_600SemiBold', fontSize: 16 },
  small: { fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 19 },
  button: { padding: 14, borderRadius: 8, minHeight: 48, alignItems: 'center' },
});