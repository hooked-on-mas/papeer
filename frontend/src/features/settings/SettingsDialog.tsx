import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Settings, Cpu, FileText } from "lucide-react";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PROVIDERS = ["codex", "claude", "gemini", "ollama", "openai"];

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const queryClient = useQueryClient();

  const { data: settingsResponse, isLoading: isLoadingSettings } = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await api.GET("/api/settings");
      if (res.error) throw res.error;
      return res.data;
    },
    enabled: open,
  });

  const [provider, setProvider] = useState("codex");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    if (settingsResponse) {
      setProvider(settingsResponse.provider || "codex");
      setModel(settingsResponse.model || "");
      setApiKey(settingsResponse.api_key || "");
    }
  }, [settingsResponse]);

  const { data: modelsResponse, isLoading: isLoadingModels } = useQuery({
    queryKey: ["models", provider],
    queryFn: async () => {
      const res = await api.GET("/api/providers/{provider}/models", {
        params: { path: { provider } },
      });
      if (res.error) throw res.error;
      return res.data as any;
    },
    enabled: !!provider && open,
  });

  const updateSettingsMutation = useMutation({
    mutationFn: async (newSettings: any) => {
      const res = await api.PUT("/api/settings", {
        body: newSettings,
      });
      if (res.error) throw res.error;
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      onOpenChange(false);
    },
  });

  const handleSave = () => {
    if (!settingsResponse) return;
    updateSettingsMutation.mutate({
      ...settingsResponse,
      provider,
      model,
      api_key: apiKey,
    });
  };

  const modelsList = Array.isArray(modelsResponse) ? modelsResponse : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5" />
            設定
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="llm" className="flex-1 flex flex-col h-[400px]">
          <div className="px-6 border-b shrink-0">
            <TabsList className="bg-transparent space-x-2">
              <TabsTrigger value="general" className="data-[state=active]:bg-background data-[state=active]:shadow-sm border border-transparent data-[state=active]:border-border">
                <Settings className="w-4 h-4 mr-2" /> 一般
              </TabsTrigger>
              <TabsTrigger value="llm" className="data-[state=active]:bg-background data-[state=active]:shadow-sm border border-transparent data-[state=active]:border-border">
                <Cpu className="w-4 h-4 mr-2" /> LLM
              </TabsTrigger>
              <TabsTrigger value="prompts" className="data-[state=active]:bg-background data-[state=active]:shadow-sm border border-transparent data-[state=active]:border-border">
                <FileText className="w-4 h-4 mr-2" /> プロンプト
              </TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            <TabsContent value="general" className="m-0 space-y-4">
              <div className="text-sm text-muted-foreground">一般設定は現在準備中です。</div>
            </TabsContent>

            <TabsContent value="llm" className="m-0 space-y-6">
              <div className="grid gap-2">
                <label className="text-sm font-medium">プロバイダー</label>
                <Select value={provider} onValueChange={(v: string | null) => setProvider(v || "")}>
                  <SelectTrigger>
                    <SelectValue placeholder="プロバイダーを選択" />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p.charAt(0).toUpperCase() + p.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <label className="text-sm font-medium">モデル</label>
                <Select value={model} onValueChange={(v: string | null) => setModel(v || "")} disabled={isLoadingModels}>
                  <SelectTrigger>
                    <SelectValue placeholder="モデルを選択" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelsList.map((m: any) => {
                      const modelId = typeof m === "string" ? m : m.id || m.name;
                      return (
                        <SelectItem key={modelId} value={modelId}>
                          {modelId}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <label className="text-sm font-medium">API キー</label>
                <Input
                  type="password"
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
            </TabsContent>

            <TabsContent value="prompts" className="m-0 space-y-4">
              <div className="text-sm text-muted-foreground">システムプロンプトのカスタマイズ機能は現在準備中です。</div>
            </TabsContent>
          </div>
          
          <div className="px-6 py-4 border-t bg-muted/20 flex justify-end shrink-0">
            <Button onClick={handleSave} disabled={updateSettingsMutation.isPending || isLoadingSettings}>
              {updateSettingsMutation.isPending ? "保存中..." : "保存"}
            </Button>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
