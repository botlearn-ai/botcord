import { Redirect, Stack, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { HumanProvider } from "@/lib/human";
import { SessionProvider, useSession } from "@/lib/session";
import { colors } from "@/lib/theme";

function AuthGate() {
  const { session, loading } = useSession();
  const segments = useSegments();
  const onLogin = segments[0] === "login";

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  if (!session && !onLogin) return <Redirect href="/login" />;
  if (session && onLogin) return <Redirect href="/" />;

  const stack = (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="rooms/[roomId]" options={{ title: "" }} />
      <Stack.Screen name="agents/[agentId]" options={{ title: "" }} />
    </Stack>
  );
  // HumanProvider needs a session; keep it out of the login screen.
  return session ? <HumanProvider key={session.user.id}>{stack}</HumanProvider> : stack;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <AuthGate />
      </SessionProvider>
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}
