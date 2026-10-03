import React, { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Redirect } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { useColors } from '@/hooks/useColors';
import { useSession } from '@/lib/session';

export default function SignIn() {
  const c = useColors(); const session = useSession(); const insets = useSafeAreaInsets();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null); const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  if (session.signedIn) return <Redirect href="/(tabs)" />;
  const input = [styles.input, { color: c.foreground, borderColor: c.border, backgroundColor: c.card }];
  async function submit() {
    if (busy) return;
    if (challenge ? !/^\d{6}$/.test(code) : !email.trim() || !password) { setError(challenge ? 'Enter your six-digit authentication code.' : 'Enter your email and password.'); return; }
    setBusy(true); setError(null);
    try {
      const next = await session.signIn(email.trim(), password, challenge ?? undefined, code);
      setPassword(''); setCode(''); setChallenge(next);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to sign in.');
      // Challenges are single-use, including incorrect attempts.
      if (challenge) { setChallenge(null); setCode(''); setPassword(''); }
    } finally { setBusy(false); }
  }
  return <KeyboardAwareScrollViewCompat style={{ backgroundColor: c.background }} bottomOffset={30} keyboardShouldPersistTaps="handled"
    contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 26, paddingTop: (Platform.OS === 'web' ? 67 : insets.top) + 32, paddingBottom: Math.max(insets.bottom, 34), gap: 24 }}>
    <View style={styles.logo}><Feather name="trending-up" size={30} color={c.primary} /><Text style={[styles.brand, { color: c.foreground }]}>AUTOPIPSZ</Text></View>
    <View style={{ marginTop: 32, gap: 12 }}><Text style={[styles.kicker, { color: c.primary }]}>YOUR ACCOUNT. AT A GLANCE.</Text>
      <Text style={[styles.title, { color: c.foreground }]}>{challenge ? 'Verify it’s you.' : 'Stay connected.\nStay informed.'}</Text>
      <Text style={[styles.body, { color: c.mutedForeground }]}>{challenge ? 'Enter the code from your authenticator app. Each challenge can only be used once.' : 'Check your balance, positions and account activity with your existing Autopipsz account.'}</Text></View>
    <View style={{ gap: 12 }}>
      {challenge ? <><Text style={{ color: c.mutedForeground }}>Authentication code</Text><TextInput testID="two-factor-code" accessibilityLabel="Authentication code" value={code} onChangeText={setCode} keyboardType="number-pad" textContentType="oneTimeCode" maxLength={6} style={input} /></> : <>
        <Text style={{ color: c.mutedForeground }}>Email address</Text><TextInput testID="email" accessibilityLabel="Email address" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="username" placeholder="you@example.com" placeholderTextColor={c.mutedForeground} style={input} />
        <Text style={{ color: c.mutedForeground }}>Password</Text><TextInput testID="password" accessibilityLabel="Password" value={password} onChangeText={setPassword} secureTextEntry textContentType="password" onSubmitEditing={() => void submit()} style={input} />
      </>}
      {(error || session.error) && <Text accessibilityRole="alert" style={[styles.body, { color: c.destructive }]}>{error || session.error}</Text>}
      <Pressable testID="submit-sign-in" accessibilityRole="button" disabled={busy} onPress={() => void submit()} style={({ pressed }) => [styles.button, { backgroundColor: c.primary, opacity: pressed || busy ? 0.65 : 1 }]}>
        {busy ? <ActivityIndicator color={c.primaryForeground} /> : <Text style={[styles.buttonText, { color: c.primaryForeground }]}>{challenge ? 'Verify & sign in' : 'Sign in securely'}</Text>}
      </Pressable>
      {challenge && <Pressable onPress={() => { setChallenge(null); setCode(''); setError(null); }} style={{ padding: 12 }}><Text style={{ color: c.primary }}>Back to sign in</Text></Pressable>}
    </View>
    <View style={[styles.notice, { borderColor: c.border }]}><Feather name="shield" size={18} color={c.primary} /><Text style={[styles.body, { color: c.mutedForeground, flex: 1 }]}>Read-only access. Your funds and trading controls stay on the Autopipsz platform.</Text></View>
  </KeyboardAwareScrollViewCompat>;
}
const styles = StyleSheet.create({
  logo: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  brand: { fontFamily: 'Inter_700Bold', fontSize: 20, letterSpacing: 2 },
  kicker: { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 1.8 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 34, lineHeight: 42 },
  body: { fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 22 },
  input: { borderWidth: 1, borderRadius: 8, minHeight: 54, padding: 15, fontSize: 16, fontFamily: 'Inter_400Regular' },
  button: { borderRadius: 8, minHeight: 54, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  buttonText: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  notice: { borderTopWidth: 1, paddingTop: 22, flexDirection: 'row', gap: 12, marginTop: 12 },
});