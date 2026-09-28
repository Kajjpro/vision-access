/**
 * Settings. Guidance level and the activity signal.
 *
 * A route rather than an inline mode: it is reachable mid-journey from the home
 * menu, and a rider who changes the level while waiting for a bus should come
 * back to the journey rather than to a remounted one.
 */
import { SettingsScreen } from "./SettingsScreen";

export const metadata = {
  title: "Тохиргоо",
  description: "Дуут удирдлагын түвшин, мэдэгдлийн тохиргоог өөрчилнө.",
  alternates: { canonical: "/settings" },
};

export default function SettingsPage() {
  return <SettingsScreen />;
}
