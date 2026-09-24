import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";

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
      // Assuming it returns an array of strings or array of objects with id/name
      return res.data as any; // Adjust if you know the exact schema
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
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <label className="text-sm font-medium">Provider</label>
            <Select value={provider} onValueChange={(v: string | null) => setProvider(v || "")}>
              <SelectTrigger>
                <SelectValue placeholder="Select a provider" />
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
            <label className="text-sm font-medium">Model</label>
            <Select value={model} onValueChange={(v: string | null) => setModel(v || "")} disabled={isLoadingModels}>
              <SelectTrigger>
                <SelectValue placeholder="Select a model" />
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
            <label className="text-sm font-medium">API Key</label>
            <Input
              type="password"
              placeholder="Enter API Key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={updateSettingsMutation.isPending || isLoadingSettings}>
            {updateSettingsMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
