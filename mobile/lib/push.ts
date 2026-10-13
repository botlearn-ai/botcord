import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { api } from "./api";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

let registeredToken: string | null = null;

async function getExpoPushToken(): Promise<string | null> {
  // Push tokens need a physical device and an EAS project id (`eas init`).
  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (Platform.OS === "web" || !Device.isDevice || !projectId) return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Messages",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") {
    ({ status } = await Notifications.requestPermissionsAsync());
  }
  if (status !== "granted") return null;
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return data;
}

export async function registerForPush(): Promise<void> {
  try {
    const token = await getExpoPushToken();
    if (!token) return;
    await api.registerPushToken(token, Platform.OS);
    registeredToken = token;
  } catch (err) {
    console.warn("push registration failed", err);
  }
}

// Call before signOut so the device stops receiving this user's messages.
export async function unregisterPush(): Promise<void> {
  if (!registeredToken) return;
  try {
    await api.deletePushToken(registeredToken);
  } catch (err) {
    console.warn("push unregister failed", err);
  }
  registeredToken = null;
}

function openFromNotification(response: Notifications.NotificationResponse | null) {
  const roomId = response?.notification.request.content.data?.room_id;
  if (typeof roomId === "string") {
    router.push({ pathname: "/rooms/[roomId]", params: { roomId } });
  }
}

export function usePushRegistration() {
  useEffect(() => {
    void registerForPush();
    // Cold start from a tapped notification, then taps while running.
    const last = Notifications.getLastNotificationResponse();
    if (last) openFromNotification(last);
    const sub = Notifications.addNotificationResponseReceivedListener(openFromNotification);
    return () => sub.remove();
  }, []);
}
