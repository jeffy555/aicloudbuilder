import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import Header from "@/components/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Clock,
  MessageSquare,
  FileCode,
  ArrowRight,
  History as HistoryIcon,
  Layers,
  Container,
  Terminal,
  Blocks,
  Ship,
  Award,
  FolderOpen,
} from "lucide-react";

const MODULES = [
  { key: "all", label: "All" },
  { key: "terraform", label: "Terraform" },
  { key: "kubernetes", label: "Kubernetes" },
  { key: "automation", label: "Automation" },
  { key: "archme", label: "ArchMe" },
  { key: "docker", label: "Docker" },
  { key: "scoreme", label: "ScoreMe" },
] as const;

const MODULE_COLORS: Record<string, string> = {
  terraform: "bg-blue-500/15 text-blue-700 border-blue-300",
  kubernetes: "bg-purple-500/15 text-purple-700 border-purple-300",
  automation: "bg-green-500/15 text-green-700 border-green-300",
  archme: "bg-orange-500/15 text-orange-700 border-orange-300",
  docker: "bg-cyan-500/15 text-cyan-700 border-cyan-300",
  scoreme: "bg-amber-500/15 text-amber-700 border-amber-300",
  unknown: "bg-gray-500/15 text-gray-700 border-gray-300",
};

const MODULE_ICONS: Record<string, React.ReactNode> = {
  terraform: <Layers className="w-4 h-4" />,
  kubernetes: <Container className="w-4 h-4" />,
  automation: <Terminal className="w-4 h-4" />,
  archme: <Blocks className="w-4 h-4" />,
  docker: <Ship className="w-4 h-4" />,
  scoreme: <Award className="w-4 h-4" />,
  unknown: <FolderOpen className="w-4 h-4" />,
};

const MODULE_ROUTES: Record<string, string> = {
  terraform: "/terraform",
  kubernetes: "/kubernetes",
  automation: "/automation",
  archme: "/archme",
  docker: "/docker",
  scoreme: "/scoreme",
};

const SESSION_STORAGE_KEYS: Record<string, string> = {
  terraform: "terraform_workflow_session_id",
  kubernetes: "kubernetes_workflow_session_id",
  automation: "automation_workflow_session_id",
  archme: "archme_workflow_session_id",
  docker: "docker_workflow_session_id",
};

interface EnrichedSession {
  id: string;
  repositoryName: string | null;
  currentStep: string;
  workflowStep: string;
  activeModule: string | null;
  inferredModule: string;
  messageCount: number;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

interface UserActivityItem {
  id: string;
  module: string;
  actionType: string;
  actionLabel: string;
  metadata: any;
  createdAt: string;
}

interface HistoryResponse {
  sessions: EnrichedSession[];
  activities: UserActivityItem[];
  totalSessions: number;
  totalActivities: number;
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export default function History() {
  const [activeTab, setActiveTab] = useState("all");
  const [, setLocation] = useLocation();

  const { data, isLoading, error } = useQuery<HistoryResponse>({
    queryKey: ["/api/user/history", activeTab],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/user/history?module=${activeTab === "all" ? "" : activeTab}`
      );
      return res.json();
    },
  });

  const handleContinueSession = (session: EnrichedSession) => {
    const module = session.inferredModule;
    const storageKey = SESSION_STORAGE_KEYS[module];
    if (storageKey) {
      localStorage.setItem(storageKey, session.id);
    }
    const route = MODULE_ROUTES[module];
    if (route) {
      setLocation(route);
    }
  };

  // Merge sessions and activities into a single timeline, sorted by date
  const timelineItems: Array<
    | { type: "session"; data: EnrichedSession; date: string }
    | { type: "activity"; data: UserActivityItem; date: string }
  > = [];

  if (data) {
    for (const s of data.sessions) {
      timelineItems.push({ type: "session", data: s, date: s.updatedAt });
    }
    for (const a of data.activities) {
      timelineItems.push({ type: "activity", data: a, date: a.createdAt });
    }
    timelineItems.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center gap-3 mb-6">
          <HistoryIcon className="w-6 h-6 text-primary" />
          <h2 className="text-2xl font-bold tracking-tight">History</h2>
        </div>

        {/* Module filter tabs */}
        <div className="flex flex-wrap gap-2 mb-6">
          {MODULES.map((m) => (
            <Button
              key={m.key}
              variant={activeTab === m.key ? "default" : "outline"}
              size="sm"
              onClick={() => setActiveTab(m.key)}
            >
              {m.key !== "all" && MODULE_ICONS[m.key]}
              <span className={m.key !== "all" ? "ml-1.5" : ""}>{m.label}</span>
            </Button>
          ))}
        </div>

        {/* Loading state */}
        {isLoading && (
          <div className="space-y-4">
            {[1, 2, 3, 4].map((i) => (
              <Card key={i}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-6 w-20" />
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-4 w-24 ml-auto" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Error state */}
        {error && (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              Failed to load history. Please try again.
            </CardContent>
          </Card>
        )}

        {/* Empty state */}
        {data && timelineItems.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              <FolderOpen className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium">No history yet</p>
              <p className="text-sm mt-1">
                Start using any module to see your activity here.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Timeline */}
        {data && timelineItems.length > 0 && (
          <ScrollArea className="h-[calc(100vh-260px)]">
            <div className="space-y-3 pr-4">
              {timelineItems.map((item) => {
                if (item.type === "session") {
                  const s = item.data;
                  const mod = s.inferredModule;
                  return (
                    <Card
                      key={`s-${s.id}`}
                      className="hover:shadow-md transition-shadow"
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1.5">
                              <Badge
                                variant="outline"
                                className={`text-[11px] px-2 py-0.5 ${MODULE_COLORS[mod] || MODULE_COLORS.unknown}`}
                              >
                                {MODULE_ICONS[mod] || MODULE_ICONS.unknown}
                                <span className="ml-1">{mod}</span>
                              </Badge>
                              {s.repositoryName && (
                                <span className="text-sm font-medium text-foreground truncate">
                                  {s.repositoryName}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-4 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <MessageSquare className="w-3 h-3" />
                                {s.messageCount} messages
                              </span>
                              <span className="flex items-center gap-1">
                                <FileCode className="w-3 h-3" />
                                {s.fileCount} files
                              </span>
                              <span className="flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {timeAgo(s.updatedAt)}
                              </span>
                            </div>
                          </div>
                          {MODULE_ROUTES[mod] && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleContinueSession(s)}
                              className="shrink-0"
                            >
                              Continue
                              <ArrowRight className="w-3.5 h-3.5 ml-1" />
                            </Button>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                }

                // Activity item (e.g. ScoreMe)
                const a = item.data;
                return (
                  <Card
                    key={`a-${a.id}`}
                    className="hover:shadow-md transition-shadow"
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1.5">
                            <Badge
                              variant="outline"
                              className={`text-[11px] px-2 py-0.5 ${MODULE_COLORS[a.module] || MODULE_COLORS.unknown}`}
                            >
                              {MODULE_ICONS[a.module] || MODULE_ICONS.unknown}
                              <span className="ml-1">{a.module}</span>
                            </Badge>
                            <span className="text-sm font-medium text-foreground truncate">
                              {a.actionLabel}
                            </span>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {timeAgo(a.createdAt)}
                            </span>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </main>
    </div>
  );
}
