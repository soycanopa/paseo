import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Bot, ChevronDown, Plus, Terminal } from "lucide-react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { Combobox } from "@/components/ui/combobox";
import { ClaudeIcon } from "@/components/icons/claude-icon";
import { CodexIcon } from "@/components/icons/codex-icon";
import { ExplorerSidebar } from "@/components/explorer-sidebar";
import { TerminalPane } from "@/components/terminal-pane";
import { ExplorerSidebarAnimationProvider } from "@/contexts/explorer-sidebar-animation-context";
import { useExplorerOpenGesture } from "@/hooks/use-explorer-open-gesture";
import { usePanelStore, type ExplorerCheckoutContext } from "@/stores/panel-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  buildWorkspaceTabPersistenceKey,
  useWorkspaceTabsStore,
  type WorkspaceTabTarget,
} from "@/stores/workspace-tabs-store";
import {
  buildHostWorkspaceAgentRoute,
  buildHostWorkspaceTerminalRoute,
} from "@/utils/host-routes";
import { buildNewAgentRoute } from "@/utils/new-agent-routing";
import { useHostRuntimeSession } from "@/runtime/host-runtime";
import {
  checkoutStatusQueryKey,
  type CheckoutStatusPayload,
} from "@/hooks/use-checkout-status-query";
import { AgentReadyScreen } from "@/screens/agent/agent-ready-screen";
import type { ListTerminalsResponse } from "@server/shared/messages";
import { upsertTerminalListEntry } from "@/utils/terminal-list";

const TERMINALS_QUERY_STALE_TIME = 5_000;
const NEW_TAB_AGENT_OPTION_ID = "__new_tab_agent__";
const NEW_TAB_TERMINAL_OPTION_ID = "__new_tab_terminal__";

type TabAvailability = "available" | "invalid" | "unknown";

type RouteTabTarget = WorkspaceTabTarget | null;

type WorkspaceScreenProps = {
  serverId: string;
  workspaceId: string;
  routeTab: RouteTabTarget;
};

type WorkspaceTabDescriptor =
  | {
      key: string;
      kind: "agent";
      agentId: string;
      provider: Agent["provider"];
      label: string;
      subtitle: string;
    }
  | {
      key: string;
      kind: "terminal";
      terminalId: string;
      label: string;
      subtitle: string;
    };

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function deriveWorkspaceName(workspaceId: string): string {
  const normalized = workspaceId.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last ?? workspaceId;
}

function deriveWorkspaceHeaderTitle(input: {
  workspaceName: string;
  checkout: CheckoutStatusPayload | null;
}): string {
  if (!input.checkout?.isGit) {
    return input.workspaceName;
  }

  const branch = trimNonEmpty(input.checkout.currentBranch ?? null);
  if (!branch || branch === "HEAD") {
    return input.workspaceName;
  }

  return branch;
}

function formatProviderLabel(provider: Agent["provider"]): string {
  if (provider === "claude") {
    return "Claude";
  }
  if (provider === "codex") {
    return "Codex";
  }
  if (!provider) {
    return "Agent";
  }
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function normalizeWorkspaceTab(
  value: WorkspaceTabTarget | null | undefined
): WorkspaceTabTarget | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (value.kind === "agent") {
    const agentId = trimNonEmpty(decodeSegment(value.agentId));
    if (!agentId) {
      return null;
    }
    return { kind: "agent", agentId };
  }
  if (value.kind === "terminal") {
    const terminalId = trimNonEmpty(decodeSegment(value.terminalId));
    if (!terminalId) {
      return null;
    }
    return { kind: "terminal", terminalId };
  }
  return null;
}

function tabEquals(left: WorkspaceTabTarget | null, right: WorkspaceTabTarget | null): boolean {
  if (!left || !right) {
    return left === right;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "agent" && right.kind === "agent") {
    return left.agentId === right.agentId;
  }
  if (left.kind === "terminal" && right.kind === "terminal") {
    return left.terminalId === right.terminalId;
  }
  return false;
}

function buildTabRoute(input: {
  serverId: string;
  workspaceId: string;
  tab: WorkspaceTabTarget;
}): string {
  if (input.tab.kind === "agent") {
    return buildHostWorkspaceAgentRoute(
      input.serverId,
      input.workspaceId,
      input.tab.agentId
    );
  }
  return buildHostWorkspaceTerminalRoute(
    input.serverId,
    input.workspaceId,
    input.tab.terminalId
  );
}

function resolveTabAvailability(input: {
  tab: WorkspaceTabTarget;
  agentsHydrated: boolean;
  terminalsHydrated: boolean;
  agentsById: Map<string, Agent>;
  terminalIds: Set<string>;
}): TabAvailability {
  if (input.tab.kind === "agent") {
    if (!input.agentsHydrated) {
      return "unknown";
    }
    return input.agentsById.has(input.tab.agentId) ? "available" : "invalid";
  }
  if (!input.terminalsHydrated) {
    return "unknown";
  }
  return input.terminalIds.has(input.tab.terminalId) ? "available" : "invalid";
}

function sortAgentsByCreatedAtDescending(agents: Agent[]): Agent[] {
  return [...agents].sort((left, right) => {
    const createdAtDelta =
      right.createdAt.getTime() - left.createdAt.getTime();
    if (createdAtDelta !== 0) {
      return createdAtDelta;
    }
    return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
  });
}

export function WorkspaceScreen({
  serverId,
  workspaceId,
  routeTab,
}: WorkspaceScreenProps) {
  return (
    <ExplorerSidebarAnimationProvider>
      <WorkspaceScreenContent serverId={serverId} workspaceId={workspaceId} routeTab={routeTab} />
    </ExplorerSidebarAnimationProvider>
  );
}

function WorkspaceScreenContent({
  serverId,
  workspaceId,
  routeTab,
}: WorkspaceScreenProps) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";

  const normalizedServerId = trimNonEmpty(decodeSegment(serverId)) ?? "";
  const normalizedWorkspaceId = trimNonEmpty(decodeSegment(workspaceId)) ?? "";

  const queryClient = useQueryClient();
  const { client, isConnected } = useHostRuntimeSession(normalizedServerId);

  const sessionAgents = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.agents
  );
  const workspaceAgents = useMemo(() => {
    if (!sessionAgents || !normalizedWorkspaceId) {
      return [] as Agent[];
    }

    const collected: Agent[] = [];
    for (const agent of sessionAgents.values()) {
      if (agent.archivedAt) {
        continue;
      }
      if ((trimNonEmpty(agent.cwd) ?? "") !== normalizedWorkspaceId) {
        continue;
      }
      collected.push(agent);
    }

    return sortAgentsByCreatedAtDescending(collected);
  }, [normalizedWorkspaceId, sessionAgents]);

  const terminalsQueryKey = useMemo(
    () => ["terminals", normalizedServerId, normalizedWorkspaceId] as const,
    [normalizedServerId, normalizedWorkspaceId]
  );
  type ListTerminalsPayload = ListTerminalsResponse["payload"];
  const terminalsQuery = useQuery({
    queryKey: terminalsQueryKey,
    enabled:
      Boolean(client && isConnected) &&
      normalizedWorkspaceId.length > 0 &&
      normalizedWorkspaceId.startsWith("/"),
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return await client.listTerminals(normalizedWorkspaceId);
    },
    staleTime: TERMINALS_QUERY_STALE_TIME,
  });
  const terminals = terminalsQuery.data?.terminals ?? [];
  const createTerminalMutation = useMutation({
    mutationFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return await client.createTerminal(normalizedWorkspaceId);
    },
    onSuccess: (payload) => {
      const createdTerminal = payload.terminal;
      if (createdTerminal) {
        queryClient.setQueryData<ListTerminalsPayload>(
          terminalsQueryKey,
          (current) => {
            const nextTerminals = upsertTerminalListEntry({
              terminals: current?.terminals ?? [],
              terminal: createdTerminal,
            });
            return {
              cwd: current?.cwd ?? normalizedWorkspaceId,
              terminals: nextTerminals,
              requestId: current?.requestId ?? `terminal-create-${createdTerminal.id}`,
            };
          }
        );
      }

      void queryClient.invalidateQueries({ queryKey: terminalsQueryKey });
      if (createdTerminal) {
        navigateToTab({ kind: "terminal", terminalId: createdTerminal.id });
      }
    },
  });

  useEffect(() => {
    if (!client || !isConnected || !normalizedWorkspaceId.startsWith("/")) {
      return;
    }

    const unsubscribeChanged = client.on("terminals_changed", (message) => {
      if (message.type !== "terminals_changed") {
        return;
      }
      if (message.payload.cwd !== normalizedWorkspaceId) {
        return;
      }
      void queryClient.invalidateQueries({ queryKey: terminalsQueryKey });
      void queryClient.refetchQueries({ queryKey: terminalsQueryKey, type: "active" });
    });

    const unsubscribeStreamExit = client.on("terminal_stream_exit", (message) => {
      if (message.type !== "terminal_stream_exit") {
        return;
      }
      void queryClient.invalidateQueries({ queryKey: terminalsQueryKey });
      void queryClient.refetchQueries({ queryKey: terminalsQueryKey, type: "active" });
    });

    client.subscribeTerminals({ cwd: normalizedWorkspaceId });

    return () => {
      unsubscribeChanged();
      unsubscribeStreamExit();
      client.unsubscribeTerminals({ cwd: normalizedWorkspaceId });
    };
  }, [client, isConnected, normalizedWorkspaceId, queryClient, terminalsQueryKey]);

  const checkoutQuery = useQuery({
    queryKey: checkoutStatusQueryKey(normalizedServerId, normalizedWorkspaceId),
    enabled:
      Boolean(client && isConnected) &&
      normalizedWorkspaceId.length > 0 &&
      normalizedWorkspaceId.startsWith("/"),
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return (await client.getCheckoutStatus(
        normalizedWorkspaceId
      )) as CheckoutStatusPayload;
    },
    staleTime: 15_000,
  });

  const workspaceName = useMemo(
    () => deriveWorkspaceName(normalizedWorkspaceId),
    [normalizedWorkspaceId]
  );
  const headerTitle = useMemo(
    () =>
      deriveWorkspaceHeaderTitle({
        workspaceName,
        checkout: checkoutQuery.data ?? null,
      }),
    [checkoutQuery.data, workspaceName]
  );

  const isGitCheckout = checkoutQuery.data?.isGit ?? false;
  const areWorkspaceAgentsHydrated = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.hasHydratedAgents ?? false
  );
  const areWorkspaceTerminalsHydrated = terminalsQuery.isSuccess;

  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopFileExplorerOpen = usePanelStore(
    (state) => state.desktop.fileExplorerOpen
  );
  const openFileExplorer = usePanelStore((state) => state.openFileExplorer);
  const closeToAgent = usePanelStore((state) => state.closeToAgent);
  const setActiveExplorerCheckout = usePanelStore(
    (state) => state.setActiveExplorerCheckout
  );

  const isExplorerOpen = isMobile
    ? mobileView === "file-explorer"
    : desktopFileExplorerOpen;

  const activeExplorerCheckout = useMemo<ExplorerCheckoutContext | null>(() => {
    if (!normalizedServerId || !normalizedWorkspaceId.startsWith("/")) {
      return null;
    }
    return {
      serverId: normalizedServerId,
      cwd: normalizedWorkspaceId,
      isGit: isGitCheckout,
    };
  }, [isGitCheckout, normalizedServerId, normalizedWorkspaceId]);

  useEffect(() => {
    setActiveExplorerCheckout(activeExplorerCheckout);
  }, [activeExplorerCheckout, setActiveExplorerCheckout]);

  const openExplorerForWorkspace = useCallback(() => {
    if (!activeExplorerCheckout) {
      return;
    }
    openFileExplorer();
  }, [activeExplorerCheckout, openFileExplorer]);

  const explorerOpenGesture = useExplorerOpenGesture({
    enabled: isMobile && mobileView === "agent",
    onOpen: openExplorerForWorkspace,
  });

  useEffect(() => {
    if (Platform.OS === "web" || !isExplorerOpen) {
      return;
    }

    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (isExplorerOpen) {
        closeToAgent();
        return true;
      }
      return false;
    });

    return () => handler.remove();
  }, [closeToAgent, isExplorerOpen]);

  const agentsById = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of workspaceAgents) {
      map.set(agent.id, agent);
    }
    return map;
  }, [workspaceAgents]);

  const tabs = useMemo<WorkspaceTabDescriptor[]>(() => {
    const next: WorkspaceTabDescriptor[] = [];

    for (const agent of workspaceAgents) {
      next.push({
        key: `agent:${agent.id}`,
        kind: "agent",
        agentId: agent.id,
        provider: agent.provider,
        label: agent.title?.trim() || "New agent",
        subtitle: `${formatProviderLabel(agent.provider)} agent`,
      });
    }

    for (const terminal of terminals) {
      next.push({
        key: `terminal:${terminal.id}`,
        kind: "terminal",
        terminalId: terminal.id,
        label: terminal.name,
        subtitle: "Terminal",
      });
    }

    return next;
  }, [terminals, workspaceAgents]);

  const terminalIds = useMemo(() => {
    const set = new Set<string>();
    for (const terminal of terminals) {
      set.add(terminal.id);
    }
    return set;
  }, [terminals]);

  const requestedTab = useMemo(
    () => normalizeWorkspaceTab(routeTab),
    [routeTab]
  );

  const persistenceKey = useMemo(
    () =>
      buildWorkspaceTabPersistenceKey({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
      }),
    [normalizedServerId, normalizedWorkspaceId]
  );
  const lastFocusedTabByWorkspace = useWorkspaceTabsStore(
    (state) => state.lastFocusedTabByWorkspace
  );
  const setLastFocusedTab = useWorkspaceTabsStore(
    (state) => state.setLastFocusedTab
  );

  const storedTab = useMemo(() => {
    if (!persistenceKey) {
      return null;
    }
    return normalizeWorkspaceTab(lastFocusedTabByWorkspace[persistenceKey]);
  }, [lastFocusedTabByWorkspace, persistenceKey]);

  const fallbackTab = useMemo<WorkspaceTabTarget | null>(() => {
    const first = tabs[0];
    if (!first) {
      return null;
    }
    if (first.kind === "agent") {
      return { kind: "agent", agentId: first.agentId };
    }
    return { kind: "terminal", terminalId: first.terminalId };
  }, [tabs]);

  const requestedTabAvailability = useMemo<TabAvailability | null>(() => {
    if (!requestedTab) {
      return null;
    }
    return resolveTabAvailability({
      tab: requestedTab,
      agentsHydrated: areWorkspaceAgentsHydrated,
      terminalsHydrated: areWorkspaceTerminalsHydrated,
      agentsById,
      terminalIds,
    });
  }, [
    agentsById,
    areWorkspaceAgentsHydrated,
    areWorkspaceTerminalsHydrated,
    requestedTab,
    terminalIds,
  ]);

  const storedTabAvailability = useMemo<TabAvailability | null>(() => {
    if (!storedTab) {
      return null;
    }
    return resolveTabAvailability({
      tab: storedTab,
      agentsHydrated: areWorkspaceAgentsHydrated,
      terminalsHydrated: areWorkspaceTerminalsHydrated,
      agentsById,
      terminalIds,
    });
  }, [
    agentsById,
    areWorkspaceAgentsHydrated,
    areWorkspaceTerminalsHydrated,
    storedTab,
    terminalIds,
  ]);

  const resolvedTab = useMemo<WorkspaceTabTarget | null>(() => {
    if (requestedTab && requestedTabAvailability !== "invalid") {
      return requestedTab;
    }

    if (storedTab && storedTabAvailability !== "invalid") {
      return storedTab;
    }

    return fallbackTab;
  }, [fallbackTab, requestedTab, requestedTabAvailability, storedTab, storedTabAvailability]);

  const resolvedTabAvailability = useMemo<TabAvailability | null>(() => {
    if (!resolvedTab) {
      return null;
    }

    return resolveTabAvailability({
      tab: resolvedTab,
      agentsHydrated: areWorkspaceAgentsHydrated,
      terminalsHydrated: areWorkspaceTerminalsHydrated,
      agentsById,
      terminalIds,
    });
  }, [
    agentsById,
    areWorkspaceAgentsHydrated,
    areWorkspaceTerminalsHydrated,
    resolvedTab,
    terminalIds,
  ]);

  const navigateToTab = useCallback(
    (tab: WorkspaceTabTarget) => {
      if (tabEquals(tab, resolvedTab)) {
        return;
      }
      const targetRoute = buildTabRoute({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
        tab,
      });
      setLastFocusedTab({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
        tab,
      });
      router.replace(targetRoute as any);
    },
    [
      normalizedServerId,
      normalizedWorkspaceId,
      resolvedTab,
      router,
      setLastFocusedTab,
    ]
  );

  useEffect(() => {
    if (!resolvedTab) {
      return;
    }
    if (resolvedTabAvailability !== "available") {
      return;
    }

    setLastFocusedTab({
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
      tab: resolvedTab,
    });
  }, [
    normalizedServerId,
    normalizedWorkspaceId,
    resolvedTab,
    resolvedTabAvailability,
    setLastFocusedTab,
  ]);

  useEffect(() => {
    if (!resolvedTab) {
      return;
    }

    if (tabEquals(requestedTab, resolvedTab)) {
      return;
    }

    const targetRoute = buildTabRoute({
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
      tab: resolvedTab,
    });

    router.replace(targetRoute as any);
  }, [
    normalizedServerId,
    normalizedWorkspaceId,
    requestedTab,
    resolvedTab,
    router,
  ]);

  const [isTabSwitcherOpen, setIsTabSwitcherOpen] = useState(false);
  const [isNewTabMenuOpen, setIsNewTabMenuOpen] = useState(false);
  const tabSwitcherAnchorRef = useRef<View>(null);
  const newTabAnchorRef = useRef<View>(null);

  const tabByKey = useMemo(() => {
    const map = new Map<string, WorkspaceTabTarget>();
    for (const tab of tabs) {
      if (tab.kind === "agent") {
        map.set(tab.key, { kind: "agent", agentId: tab.agentId });
        continue;
      }
      map.set(tab.key, { kind: "terminal", terminalId: tab.terminalId });
    }
    return map;
  }, [tabs]);

  const activeTabKey = useMemo(() => {
    if (!resolvedTab) {
      return "";
    }
    if (resolvedTab.kind === "agent") {
      return `agent:${resolvedTab.agentId}`;
    }
    return `terminal:${resolvedTab.terminalId}`;
  }, [resolvedTab]);

  const tabSwitcherOptions = useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.key,
        label: tab.label,
        description: tab.subtitle,
      })),
    [tabs]
  );

  const newTabOptions = useMemo(
    () => [
      {
        id: NEW_TAB_AGENT_OPTION_ID,
        label: "Agent tab",
        description: "Open the draft agent flow for this workspace",
      },
      {
        id: NEW_TAB_TERMINAL_OPTION_ID,
        label: "Terminal tab",
        description: "Create a new terminal in this workspace",
      },
    ],
    []
  );

  const activeTabLabel = useMemo(() => {
    const active = tabs.find((tab) => tab.key === activeTabKey);
    return active?.label ?? "Select tab";
  }, [activeTabKey, tabs]);

  const handleCreateAgent = useCallback(() => {
    if (!normalizedServerId) {
      return;
    }
    router.push(
      buildNewAgentRoute(normalizedServerId, normalizedWorkspaceId) as any
    );
  }, [normalizedServerId, normalizedWorkspaceId, router]);

  const handleCreateTerminal = useCallback(() => {
    if (createTerminalMutation.isPending) {
      return;
    }
    if (!normalizedWorkspaceId.startsWith("/")) {
      return;
    }
    createTerminalMutation.mutate();
  }, [createTerminalMutation, normalizedWorkspaceId]);

  const handleSelectSwitcherTab = useCallback(
    (key: string) => {
      const tab = tabByKey.get(key);
      if (!tab) {
        return;
      }
      setIsTabSwitcherOpen(false);
      navigateToTab(tab);
    },
    [navigateToTab, tabByKey]
  );

  const handleSelectNewTabOption = useCallback(
    (key: string) => {
      setIsNewTabMenuOpen(false);
      if (key === NEW_TAB_AGENT_OPTION_ID) {
        handleCreateAgent();
        return;
      }
      if (key === NEW_TAB_TERMINAL_OPTION_ID) {
        handleCreateTerminal();
      }
    },
    [handleCreateAgent, handleCreateTerminal]
  );

  const renderContent = () => {
    if (!resolvedTab) {
      return (
        <View style={styles.emptyState}>
          <Text style={styles.emptyStateText}>
            No tabs are available yet. Use New tab to create an agent or terminal.
          </Text>
        </View>
      );
    }

    if (resolvedTab.kind === "agent") {
      return (
        <AgentReadyScreen
          serverId={normalizedServerId}
          agentId={resolvedTab.agentId}
          showHeader={false}
          showExplorerSidebar={false}
          wrapWithExplorerSidebarProvider={false}
        />
      );
    }

    return (
      <TerminalPane
        serverId={normalizedServerId}
        cwd={normalizedWorkspaceId}
        selectedTerminalId={resolvedTab.terminalId}
        onSelectedTerminalIdChange={(terminalId) => {
          if (!terminalId) {
            return;
          }
          navigateToTab({ kind: "terminal", terminalId });
        }}
        hideHeader
        manageTerminalDirectorySubscription={false}
      />
    );
  };

  return (
    <View style={styles.container}>
      <ScreenHeader
        left={
          <>
            <SidebarMenuToggle />
            <Text style={styles.headerTitle} numberOfLines={1}>
              {headerTitle}
            </Text>
          </>
        }
        right={
          <View style={styles.headerRight}>
            {isMobile ? (
              <Pressable
                ref={tabSwitcherAnchorRef}
                style={({ hovered, pressed }) => [
                  styles.switcherTrigger,
                  (hovered || pressed) && styles.switcherTriggerActive,
                ]}
                onPress={() => setIsTabSwitcherOpen(true)}
              >
                <Text style={styles.switcherTriggerText} numberOfLines={1}>
                  {activeTabLabel}
                </Text>
                <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
              </Pressable>
            ) : null}

            <Pressable
              ref={newTabAnchorRef}
              testID="workspace-new-tab"
              style={({ hovered, pressed }) => [
                styles.newTabButton,
                (hovered || pressed) && styles.newTabButtonActive,
              ]}
              onPress={() => setIsNewTabMenuOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="New tab"
            >
              <Plus size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
              <Text style={styles.newTabButtonText}>New tab</Text>
              <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
            </Pressable>

            {isMobile ? (
              <Combobox
                options={tabSwitcherOptions}
                value={activeTabKey}
                onSelect={handleSelectSwitcherTab}
                searchable={false}
                title="Switch tab"
                searchPlaceholder="Search tabs"
                open={isTabSwitcherOpen}
                onOpenChange={setIsTabSwitcherOpen}
                anchorRef={tabSwitcherAnchorRef}
              />
            ) : null}

            <Combobox
              options={newTabOptions}
              value=""
              onSelect={handleSelectNewTabOption}
              searchable={false}
              title="New tab"
              searchPlaceholder="Search tab types"
              open={isNewTabMenuOpen}
              onOpenChange={setIsNewTabMenuOpen}
              anchorRef={newTabAnchorRef}
            />
          </View>
        }
      />

      {!isMobile ? (
        <View style={styles.tabsContainer}>
          <ScrollView
            horizontal
            style={styles.tabsScroll}
            contentContainerStyle={styles.tabsContent}
            showsHorizontalScrollIndicator={false}
          >
            {tabs.map((tab) => {
              const isActive = tab.key === activeTabKey;
              const iconColor = isActive
                ? theme.colors.foreground
                : theme.colors.foregroundMuted;
              const icon =
                tab.kind === "agent" ? (
                  tab.provider === "claude" ? (
                    <ClaudeIcon size={14} color={iconColor} />
                  ) : tab.provider === "codex" ? (
                    <CodexIcon size={14} color={iconColor} />
                  ) : (
                    <Bot size={14} color={iconColor} />
                  )
                ) : (
                  <Terminal size={14} color={iconColor} />
                );

              return (
                <Pressable
                  key={tab.key}
                  style={({ hovered, pressed }) => [
                    styles.tab,
                    isActive && styles.tabActive,
                    (hovered || pressed) && styles.tabHovered,
                  ]}
                  onPress={() => {
                    if (tab.kind === "agent") {
                      navigateToTab({ kind: "agent", agentId: tab.agentId });
                      return;
                    }
                    navigateToTab({
                      kind: "terminal",
                      terminalId: tab.terminalId,
                    });
                  }}
                >
                  <View style={styles.tabIcon}>{icon}</View>
                  <Text
                    style={[styles.tabLabel, isActive && styles.tabLabelActive]}
                    numberOfLines={1}
                  >
                    {tab.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      <View style={styles.mainRow}>
        {isMobile ? (
          <GestureDetector gesture={explorerOpenGesture} touchAction="pan-y">
            <View style={styles.content}>{renderContent()}</View>
          </GestureDetector>
        ) : (
          <View style={styles.content}>{renderContent()}</View>
        )}

        <ExplorerSidebar
          serverId={normalizedServerId}
          workspaceId={normalizedWorkspaceId}
          workspaceRoot={normalizedWorkspaceId}
          isGit={isGitCheckout}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  headerTitle: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: {
      xs: "400",
      md: "300",
    },
    color: theme.colors.foreground,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  newTabButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  newTabButtonActive: {
    backgroundColor: theme.colors.surface2,
  },
  newTabButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  switcherTrigger: {
    maxWidth: 220,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  switcherTriggerActive: {
    backgroundColor: theme.colors.surface2,
  },
  switcherTriggerText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tabsContainer: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  tabsScroll: {
    flex: 1,
  },
  tabsContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  mainRow: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
  },
  tab: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: 260,
  },
  tabIcon: {
    flexShrink: 0,
  },
  tabActive: {
    backgroundColor: theme.colors.surface2,
  },
  tabHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tabLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  tabLabelActive: {
    color: theme.colors.foreground,
  },
  content: {
    flex: 1,
    minHeight: 0,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
  },
  emptyStateText: {
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
