"use client";

/** Local fixtures exercise the real admin page without issuing admin requests. */
import { useMemo, useState } from "react";
import AdminCodesPage, { type AdminCodesApi } from "@/components/admin/AdminCodesPage";
import type { BetaInviteCode } from "@/lib/api";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import DialogShell from "@/components/ui/DialogShell";
import Field from "@/components/ui/Field";
import Select from "@/components/ui/Select";
import SingleSelect from "@/components/ui/SingleSelect";
import MultiSelect from "@/components/ui/MultiSelect";

const options = Array.from({ length: 120 }, (_, i) => ({ value: String(i), label: `Agent ${i + 1} · 跨团队协作与很长的名称`, sublabel: "Long supporting description / 中文说明", disabled: i % 7 === 0 }));
const seed: BetaInviteCode = { id: "demo-1", code: "KOL_DEMO_001", label: "跨团队活动 · A long campaign name with mixed 中文 and English", max_uses: 500, used_count: 23, created_by: "fixture", expires_at: null, status: "active", created_at: "2026-10-12T00:00:00Z" };
export default function PilotGallery() {
  const [scenario, setScenario] = useState("normal");
  const [theme, setTheme] = useState("light");
  const [open, setOpen] = useState(false);
  const [single, setSingle] = useState<string | null>(null);
  const [multi, setMulti] = useState<string[]>([]);
  const api = useMemo<AdminCodesApi>(() => {
    let rows = scenario === "empty" ? [] : [seed, { ...seed, id: "demo-2", code: "OLD_DEMO_002", status: "revoked" as const }];
    const delay = () => new Promise<void>((resolve) => setTimeout(resolve, scenario === "slow" ? 2000 : 150));
    return {
      async getCodes() { await delay(); if (scenario === "error") throw new Error("演示：网络请求失败"); return { codes: [...rows] }; },
      async createCode(data) { await delay(); if (scenario === "submit-error") throw new Error("演示：服务暂不可用，请重试"); const code = { ...seed, ...data, id: `demo-${rows.length + 1}`, code: `${data.prefix}_DEMO_${rows.length + 1}`, used_count: 0 }; rows = [code, ...rows]; return code; },
      async revokeCode(id) { await delay(); rows = rows.map((row) => row.id === id ? { ...row, status: "revoked" } : row); return rows.find((row) => row.id === id)!; },
    };
  }, [scenario]);
  return <main className="mx-auto max-w-6xl space-y-8 px-4 py-8 md:px-8">
    <div className="flex flex-wrap items-center gap-3">
      <a href="/design" className="text-sm text-accent-text">返回组件库</a>
      <Button onClick={() => { const next = theme === "light" ? "dark" : "light"; setTheme(next); document.documentElement.dataset.theme = next; }}>切换主题</Button>
      <Field label="验收场景"><Select value={scenario} onChange={(event) => setScenario(event.target.value)}><option value="normal">正常列表</option><option value="empty">空列表</option><option value="slow">慢请求</option><option value="error">加载失败</option><option value="submit-error">提交失败</option></Select></Field>
      <Button onClick={() => setOpen(true)}>弹层边界测试</Button>
    </div>
    <Alert title="邀请码管理迁移试点">下方复用真实业务页面，数据只存于当前预览内存。创建和撤销不会访问后台。</Alert>
    <AdminCodesPage key={scenario} api={api} />
    {open && <DialogShell title="长内容与嵌套选择器" description="120 个选项，包含长名称和禁用项。Esc 应先关闭选择器，再关闭弹窗。" onClose={() => setOpen(false)} closeLabel="关闭边界测试">
      <div className="space-y-5">
        <Field label="单选 Agent"><SingleSelect value={single} onChange={setSingle} options={options} placeholder="选择一个 Agent" /></Field>
        <Field label="多选 Agent"><MultiSelect value={multi} onChange={setMulti} options={options} placeholder="选择多个 Agent" searchPlaceholder="搜索 120 个选项" emptyLabel="无匹配选项" /></Field>
        <p className="text-sm leading-relaxed text-text-secondary">{"长内容用于确认弹窗内部滚动、底部操作和焦点保持。 ".repeat(35)}</p>
      </div>
    </DialogShell>}
  </main>;
}
