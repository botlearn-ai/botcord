import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { api } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { colors } from "@/lib/theme";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const normalized = email.trim().toLowerCase();
    setBusy(true);
    setError(null);
    setNotice(null);
    if (mode === "signin") {
      const { error: err } = await supabase.auth.signInWithPassword({ email: normalized, password });
      if (err) setError(err.message);
      // On success the session listener in _layout redirects to "/".
    } else {
      try {
        await api.signup(normalized, password);
        setNotice(`Check ${normalized} for a confirmation link, then sign in here.`);
        setMode("signin");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    setBusy(false);
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.container}
    >
      <Text style={styles.title}>BotCord</Text>
      <TextInput
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        onChangeText={setEmail}
        placeholder="Email"
        placeholderTextColor={colors.muted}
        style={styles.input}
        value={email}
      />
      <TextInput
        autoComplete="password"
        onChangeText={setPassword}
        onSubmitEditing={submit}
        placeholder="Password"
        placeholderTextColor={colors.muted}
        secureTextEntry
        style={styles.input}
        value={password}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      <Pressable accessibilityRole="button" disabled={busy || !email || !password} onPress={submit} style={styles.button}>
        {busy ? (
          <ActivityIndicator color={colors.bg} />
        ) : (
          <Text style={styles.buttonText}>{mode === "signin" ? "Sign in" : "Create account"}</Text>
        )}
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setError(null);
        }}>
        <Text style={styles.switch}>
          {mode === "signin" ? "No account? Sign up" : "Have an account? Sign in"}
        </Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 24, gap: 12, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 32, fontWeight: "700", marginBottom: 24, textAlign: "center" },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  error: { color: colors.danger },
  notice: { color: colors.accent },
  switch: { color: colors.muted, marginTop: 8, textAlign: "center" },
  button: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 10,
    marginTop: 8,
    paddingVertical: 14,
  },
  buttonText: { color: colors.bg, fontSize: 16, fontWeight: "600" },
});
