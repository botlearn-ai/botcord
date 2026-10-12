"use client";

/**
 * [INPUT]: adminBetaApi; optional typed adapter for isolated component acceptance
 * [OUTPUT]: Invite-code list, creation form and confirmed revocation
 * [POS]: First complete shared-component migration pilot; production uses the unchanged API
 * [PROTOCOL]: Keep request payloads and list-refresh semantics; see COMPONENTS.md
 */
import { useMemo, useEffect, useRef, useState } from "react";
import { Plus, Ticket, XCircle } from "lucide-react";
import { useStore } from "zustand";
import { adminBetaApi, type BetaInviteCode } from "@/lib/api";
import { createAdminListStore } from "./admin-list-store";
import { useConfirm } from "@/store/useConfirmStore";
import Alert from "@/components/ui/Alert";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import Field from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { BotCordLoader } from "@/components/ui/BotCordLoader";
import Table, { TableHead, TableBody, TableRow, TableHeader, TableCell } from "@/components/ui/Table";

export type AdminCodesApi = Pick<typeof adminBetaApi, "getCodes" | "createCode" | "revokeCode">;
export default function AdminCodesPage({ api = adminBetaApi }: { api?: AdminCodesApi }) {
  const confirm = useConfirm();
  const store = useMemo(() => createAdminListStore<BetaInviteCode>(() => api.getCodes().then((data) => data.codes)), [api]);
  const { rows: codes, loading, error } = useStore(store);
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("");
  const [maxUses, setMaxUses] = useState(500);
  const [prefix, setPrefix] = useState("KOL");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const createLock = useRef(false);
  const revokeLock = useRef(false);
  const labelRef = useRef<HTMLInputElement>(null);
  const launchRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    void store.getState().load("codes");
    return () => store.getState().cancel();
  }, [store]);
  useEffect(() => {
    if (showForm && !creating) labelRef.current?.focus();
    else if (!showForm && !creating && restoreFocus.current) { launchRef.current?.focus(); restoreFocus.current = false; }
  }, [showForm, creating]);
  function closeForm() { restoreFocus.current = true; setShowForm(false); }
  async function handleCreate() {
    if (!label.trim() || createLock.current) return;
    createLock.current = true; setCreating(true); setFormError(null);
    try {
      await api.createCode({ label: label.trim(), max_uses: maxUses, prefix: prefix.trim() || "KOL" });
      setLabel(""); setMaxUses(500); setPrefix("KOL"); closeForm();
      await store.getState().refresh();
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : "创建失败"); }
    finally { createLock.current = false; setCreating(false); }
  }
  async function handleRevoke(id: string) {
    if (revokeLock.current) return;
    revokeLock.current = true;
    try {
      if (!(await confirm({ title: "确认撤销此邀请码？", message: "撤销后无法继续使用。", tone: "danger", confirmLabel: "撤销", cancelLabel: "取消" }))) return;
      setRevoking(id); setActionError(null);
      await api.revokeCode(id); await store.getState().refresh();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "撤销失败"); }
    finally { revokeLock.current = false; setRevoking(null); }
  }
  return <div className="min-w-0 space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="type-heading-2">邀请码管理</h2>
      <Button ref={launchRef} variant={showForm ? "secondary" : "primary"} disabled={creating} onClick={() => { setFormError(null); setShowForm((value) => !value); }}>
        <Plus className="h-4 w-4" strokeWidth={1.75} aria-hidden />创建新码
      </Button>
    </div>
    {showForm && <Card padding="lg">
      <form aria-label="创建邀请码" onSubmit={(event) => { event.preventDefault(); void handleCreate(); }} className="space-y-4">
        <h3 className="text-lg font-semibold">创建 KOL 专属码</h3>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="标注（KOL 名 / 活动名）" required><Input ref={labelRef} required disabled={creating} placeholder="如：TechWave大会" value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
          <Field label="码前缀" hint="最多 10 个字符，自动转为大写"><Input disabled={creating} placeholder="KOL" value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} maxLength={10} /></Field>
          <Field label="最大使用次数" required><Input disabled={creating} type="number" min={1} step={1} required value={maxUses} onChange={(e) => setMaxUses(Math.max(1, parseInt(e.target.value) || 1))} /></Field>
        </div>
        {formError && <Alert tone="danger" title="创建失败">{formError}</Alert>}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" variant="primary" loading={creating} disabled={!label.trim()}>创建</Button>
          <Button disabled={creating} onClick={closeForm}>取消</Button>
        </div>
      </form>
    </Card>}
    {(error || actionError) && <Alert tone="danger" title={error ? "加载失败" : "撤销失败"} actions={error ? <Button size="sm" onClick={() => void store.getState().refresh()}>重试</Button> : undefined}>{error || actionError}</Alert>}
    {loading ? <div className="flex justify-center py-12"><BotCordLoader label="正在加载邀请码" /></div> : error ? null : codes.length === 0 ? <EmptyState bordered icon={<Ticket strokeWidth={1.75} />} title="暂无邀请码" description="创建邀请码后，可以查看使用次数或撤销访问。" /> : <Card padding="none">
      <Table aria-label="邀请码列表">
        <TableHead><TableRow>{["邀请码", "标注", "用量", "状态", "创建时间", "操作"].map((heading) => <TableHeader key={heading} className="whitespace-nowrap">{heading}</TableHeader>)}</TableRow></TableHead>
        <TableBody>{codes.map((code) => <TableRow key={code.id}>
          <TableCell className="font-mono text-xs whitespace-nowrap">{code.code}</TableCell>
          <TableCell><span className="block min-w-32 max-w-64 break-words">{code.label || "—"}</span></TableCell>
          <TableCell className="tabular-nums whitespace-nowrap text-text-secondary">{code.used_count}/{code.max_uses}</TableCell>
          <TableCell><Badge tone={code.status === "active" ? "success" : "neutral"}>{code.status === "active" ? "有效" : "已撤销"}</Badge></TableCell>
          <TableCell className="type-caption whitespace-nowrap text-text-secondary">{new Date(code.created_at).toLocaleDateString("zh-CN")}</TableCell>
          <TableCell>{code.status === "active" && <Button variant="ghost" size="sm" loading={revoking === code.id} disabled={revoking !== null} onClick={() => void handleRevoke(code.id)}><XCircle className="h-4 w-4" strokeWidth={1.75} aria-hidden />撤销</Button>}</TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </Card>}
  </div>;
}
