"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { agentDefaultAccessApi, capabilityBadge, type DefaultCapability } from "@/lib/team-access";
import { useConfirm } from "@/store/useConfirmStore";

/**
 * Owner setting: the capability non-owners get through relations created from
 * now on (new friends, new groups, making the Agent public). Existing
 * relations keep their current capability.
 */
export default function AgentDefaultPermission({
  agentId,
  className = "rounded-2xl border border-glass-border bg-glass-bg/40 p-5",
}: {
  agentId: string;
  className?: string;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const confirm = useConfirm();
  const mounted = useRef(false);
  const [value, setValue] = useState<DefaultCapability | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setError(null);
    agentDefaultAccessApi
      .get(agentId, controller.signal)
      .then((res) => mounted.current && setValue(res.default_capability))
      .catch(() => {
        if (mounted.current && !controller.signal.aborted)
          setError(t("默认权限加载失败。", "Couldn't load the default permission."));
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
    // `t` only depends on the language, which doesn't change the request.
  }, [agentId, version]);

  async function choose(next: DefaultCapability) {
    if (saving || next === value) return;
    if (next === "full") {
      const ok = await confirm({
        title: t("把默认权限设为完整？", "Set the default permission to Full?"),
        message: t(
          "完整权限下，别人可以让这个 Agent 在你的电脑上运行任何命令，包括读写、删除文件和访问网络。只在你完全信任以后会接触它的人时选择。",
          "With Full, other people can make this Agent run any command on your computer, including reading, writing or deleting files and using the network. Only choose this if you fully trust everyone who will reach it.",
        ),
        confirmLabel: t("仍然设为完整", "Set to Full"),
        tone: "danger",
      });
      if (!ok || !mounted.current) return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await agentDefaultAccessApi.set(agentId, next);
      if (mounted.current) setValue(res.default_capability);
    } catch {
      if (mounted.current) setError(t("保存失败，请重试。", "Couldn't save. Try again."));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const options: { value: DefaultCapability; label: string; hint: string }[] = [
    {
      value: "consult",
      label: `${capabilityBadge("consult", zh).label}${t("（推荐）", " (recommended)")}`,
      hint: capabilityBadge("consult", zh).explanation,
    },
    {
      value: "full",
      label: capabilityBadge("full", zh).label,
      hint: `⚠️ ${capabilityBadge("full", zh).explanation}`,
    },
  ];
  return (
    <section className={className}>
      <h3 className="mb-1 text-sm font-semibold text-text-primary">
        {t("别人使用这个 Agent 时的默认权限", "Default permission when others use this agent")}
      </h3>
      <p className="mb-4 text-xs text-text-secondary">
        {t(
          "适用于之后新加的好友、新加入的群和公开这个 Agent；已有的关系不变。",
          "Applies to new friends, new groups and making the agent public. Existing relations stay unchanged.",
        )}
      </p>
      {error && (
        <p role="alert" className="mb-3 text-xs text-red-500">
          {error}
          {value == null && (
            <button type="button" className="ml-2 underline" onClick={() => setVersion((v) => v + 1)}>
              {t("重试", "Retry")}
            </button>
          )}
        </p>
      )}
      {value == null ? (
        !error && (
          <p role="status" className="flex items-center gap-2 text-xs text-text-secondary">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("正在加载…", "Loading…")}
          </p>
        )
      ) : (
        <div className="flex flex-col gap-2" role="radiogroup">
          {options.map((opt) => {
            const selected = value === opt.value;
            return (
              <label
                key={opt.value}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                  selected
                    ? opt.value === "full"
                      ? "border-red-500/40 bg-red-500/5"
                      : "border-neon-cyan/40 bg-neon-cyan/5"
                    : "border-glass-border hover:bg-glass-bg/60"
                } ${saving ? "pointer-events-none opacity-50" : ""}`}
              >
                <input
                  type="radio"
                  name={`default_capability_${agentId}`}
                  value={opt.value}
                  checked={selected}
                  disabled={saving}
                  onChange={() => void choose(opt.value)}
                  className="mt-0.5 accent-neon-cyan"
                />
                <div className="flex-1">
                  <div className="text-sm text-text-primary">{opt.label}</div>
                  <div className="text-xs text-text-secondary">{opt.hint}</div>
                </div>
              </label>
            );
          })}
          {saving && (
            <p className="flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("正在保存…", "Saving…")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
