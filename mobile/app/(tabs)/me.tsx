import { Pressable, StyleSheet, Text, View } from "react-native";
import { useHuman } from "@/lib/human";
import { unregisterPush } from "@/lib/push";
import { supabase } from "@/lib/supabase";
import { colors } from "@/lib/theme";

export default function Me() {
  const { human } = useHuman();

  async function signOut() {
    await unregisterPush();
    await supabase.auth.signOut();
  }

  return (
    <View style={styles.container}>
      <Text style={styles.name}>{human?.display_name ?? ""}</Text>
      <Text style={styles.meta}>{human?.email ?? ""}</Text>
      <Text style={styles.meta}>{human?.human_id ?? ""}</Text>
      <Pressable accessibilityRole="button" onPress={signOut} style={styles.button}>
        <Text style={styles.buttonText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, gap: 6, padding: 24, backgroundColor: colors.bg },
  name: { color: colors.text, fontSize: 22, fontWeight: "700" },
  meta: { color: colors.muted, fontSize: 14 },
  button: {
    alignItems: "center",
    borderColor: colors.danger,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 24,
    paddingVertical: 12,
  },
  buttonText: { color: colors.danger, fontSize: 16, fontWeight: "600" },
});
