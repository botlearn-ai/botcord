"use client";

/**
 * [INPUT]: 依赖 adminBetaApi (getCodes/createCode/revokeCode)
 * [OUTPUT]: Admin 邀请码管理页 — 列表 + 创建 + 撤销
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, XCircle } from "lucide-react";
import { adminBetaApi, type BetaInviteCode } from "@/lib/api";

export default function AdminCodesPage() {
  const [codes, setCodes] = useState<BetaInviteCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("");
  const [maxUses, setMaxUses] = useState(500);
  const [prefix, setPrefix] = useState("KOL");
  const [creating, setCreating] = useState(false);

  const fetchCodes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminBetaApi.getCodes();
      setCodes(data.codes);
    } catch (err: any) {
      setError(err?.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCodes(); }, [fetchCodes]);

  async function handleCreate() {
    if (!label.trim()) return;
    setCreating(true);
    try {
      await adminBetaApi.createCode({ label: label.trim(), max_uses: maxUses, prefix: prefix.trim() || "KOL" });
      setLabel("");
      setMaxUses(500);
      setPrefix("KOL");
      setShowForm(false);
      await fetchCodes();
    } catch (err: any) {
      setError(err?.message ?? "创建失败");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!confirm("确认撤销此邀请码？撤销后无法继续使用。")) return;
    try {
      await adminBetaApi.revokeCode(id);
      await fetchCodes();
    } catch (err: any) {
      setError(err?.message ?? "撤销失败");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-text-primary">邀请码管理</h2>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-2 rounded-xl bg-neon-cyan/10 px-4 py-2 text-sm font-semibold text-neon-cyan transition-colors hover:bg-neon-cyan/20"
        >
          <Plus className="h-4 w-4" />
          创建新码
        </button>
      </div>

      {showForm && (
        <div className="rounded-2xl border border-glass-border bg-deep-black-light p-5 space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">创建 KOL 专属码</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs text-text-secondary">标注（KOL 名 / 活动名）</label>
              <input
                type="text"
                placeholder="如：TechWave大会"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2 text-sm text-text-primary placeholder-text-tertiary outline-none focus:border-neon-cyan/50"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-secondary">码前缀</label>
              <input
                type="text"
                placeholder="KOL"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value.toUpperCase())}
                maxLength={10}
                className="w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2 text-sm text-text-primary placeholder-text-tertiary outline-none focus:border-neon-cyan/50"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-text-secondary">最大使用次数</label>
              <input
                type="number"
                min={1}
                value={maxUses}
                onChange={(e) => setMaxUses(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/50"
              />
            </div>
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleCreate}
              disabled={creating || !label.trim()}
              className="rounded-xl bg-neon-cyan/10 px-5 py-2 text-sm font-semibold text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:opacity-50"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : "创建"}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="rounded-xl border border-glass-border px-5 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-2 text-sm text-red-300">{error}</p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin" />
          加载中…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-glass-border">
          <table className="w-full text-sm">
            <thead className="border-b border-glass-border bg-glass-bg">
              <tr>
                <th className="px-4 py-3 text-left text-xs text-text-secondary">邀请码</th>
                <th className="px-4 py-3 text-left text-xs text-text-secondary">标注</th>
                <th className="px-4 py-3 text-left text-xs text-text-secondary">用量</th>
                <th className="px-4 py-3 text-left text-xs text-text-secondary">状态</th>
                <th className="px-4 py-3 text-left text-xs text-text-secondary">创建时间</th>
                <th className="px-4 py-3 text-left text-xs text-text-secondary">操作</th>
              </tr>
            </thead>
            <tbody>
              {codes.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-text-secondary">暂无邀请码</td>
                </tr>
              ) : (
                codes.map((c) => (
                  <tr key={c.id} className="border-b border-glass-border/50 last:border-0">
                    <td className="px-4 py-3 font-mono text-xs text-neon-cyan">{c.code}</td>
                    <td className="px-4 py-3 text-text-primary">{c.label || "—"}</td>
                    <td className="px-4 py-3 text-text-secondary">{c.used_count}/{c.max_uses}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        c.status === "active"
                          ? "bg-neon-cyan/10 text-neon-cyan"
                          : "bg-red-400/10 text-red-300"
                      }`}>
                        {c.status === "active" ? "有效" : "已撤销"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-text-secondary">
                      {new Date(c.created_at).toLocaleDateString("zh-CN")}
                    </td>
                    <td className="px-4 py-3">
                      {c.status === "active" && (
                        <button
                          onClick={() => handleRevoke(c.id)}
                          className="flex items-center gap-1 text-xs text-text-secondary transition-colors hover:text-red-300"
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          撤销
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
