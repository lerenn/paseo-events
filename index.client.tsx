import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { EventsScreen } from "./client/screen";

function EventsItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Bell" active={currentScreen?.screenId === "events"} onPress={() => openScreen({ screenId: "events" })} />;
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "events", title: "Events", Component: EventsScreen });
  client.addSidebarHeaderItem({ id: "events", title: "Events", Component: EventsItem });
  return () => {};
}
