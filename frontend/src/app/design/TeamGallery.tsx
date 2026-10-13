"use client";
/**
 * [INPUT]: Team-mode primitives (PageHeader, IconTile, PresenceIndicator, ChoiceCard, Chip, ListGroup, Alert accent) and fixtures
 * [OUTPUT]: /design#team — Team workspace building blocks without backend access
 * [POS]: /design coverage extension for components/team compositions
 * [PROTOCOL]: Add new team primitives here and update COMPONENTS.md
 */
import { useState } from "react";
import { Bot, Building2, Inbox, Plus, UserRound } from "lucide-react";
import Alert from "@/components/ui/Alert";
import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import ChoiceCard from "@/components/ui/ChoiceCard";
import Chip from "@/components/ui/Chip";
import IconTile from "@/components/ui/IconTile";
import ListGroup, { ListGroupItem } from "@/components/ui/ListGroup";
import PageHeader from "@/components/ui/PageHeader";
import PresenceIndicator from "@/components/ui/PresenceIndicator";
import type { PresenceStatus } from "@/components/ui/PresenceIndicator";

const PRESENCE: [PresenceStatus, string][] = [["online", "在线"], ["working", "工作中"], ["busy", "忙碌"], ["away", "暂离"], ["offline", "离线"]];
const ROLES = [
  { value: "consultant", title: "咨询", description: "可以向 Agent 提问，不能让它改动文件。" },
  { value: "collaborator", title: "协作", description: "可以让 Agent 在指定仓库里执行允许的命令。" },
  { value: "full", title: "完全控制", description: "你已有此权限。", disabled: true },
];

export default function TeamGallery() {
  const [role, setRole] = useState("consultant");
  const [rules, setRules] = useState(["Alice: 总是回复", "Bob: 仅被 @ 时回复"]);
  return <section id="team" className="space-y-6">
    <h2 className="type-heading-2">Team 模式</h2>
    <p className="text-sm text-text-secondary">团队空间、Agent 目录、权限申请和房间成员使用的组件。示例数据均为本地 fixture。</p>
    <Card>
      <PageHeader eyebrow="Team" title="团队空间" description="使用同一个账户和 Agent，分别管理个人与组织身份。" actions={<Button variant="primary"><Plus size={16} />创建组织</Button>} />
    </Card>
    <div className="grid gap-6 md:grid-cols-2">
      <Card className="space-y-4">
        <p className="text-xs text-text-secondary">IconTile · accent / neutral · sm / md / lg</p>
        <div className="flex flex-wrap items-end gap-3"><IconTile size="sm"><Plus /></IconTile><IconTile><Building2 /></IconTile><IconTile tone="neutral"><UserRound /></IconTile><IconTile size="lg"><Bot /></IconTile></div>
        <p className="text-xs text-text-secondary">PresenceIndicator · 出席状态（静态，不与 SignalDot 互换）</p>
        <div className="flex flex-wrap gap-4">{PRESENCE.map(([status, label]) => <span key={status} className="inline-flex items-center gap-1.5 text-xs text-text-secondary"><PresenceIndicator status={status} size="sm" />{label}</span>)}</div>
        <div className="flex items-center gap-3"><span className="relative shrink-0"><Avatar kind="agent" id="ag_gallery_atlas" name="Atlas" size="md" /><PresenceIndicator status="online" size="lg" overlay /></span><span className="min-w-0"><span className="block text-sm font-semibold">Atlas</span><span className="flex items-center gap-2 text-xs text-text-secondary"><PresenceIndicator status="online" size="xs" />在线<Badge>Claude Code</Badge>所有者: Alice</span></span></div>
      </Card>
      <fieldset className="space-y-2"><legend className="mb-2 text-sm">ChoiceCard · 你想怎么用它？</legend>
        {ROLES.map((item) => <ChoiceCard key={item.value} name="gallery-access-role" value={item.value} title={item.title} description={item.description} disabled={item.disabled} checked={role === item.value} onChange={() => setRole(item.value)} />)}
      </fieldset>
    </div>
    <Alert tone="accent" icon={<Inbox />} actions={<Button variant="secondary" size="sm">处理</Button>}>2 个权限申请待处理</Alert>
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-2">
        <p className="text-xs text-text-secondary">ListGroup · 申请列表</p>
        <ListGroup aria-label="待处理申请">
          <ListGroupItem align="start" className="flex-wrap justify-between"><span className="min-w-0"><span className="block font-medium">Alice 申请 <Badge tone="success">咨询</Badge></span><span className="block text-xs text-text-secondary">Atlas · 2026-10-13 10:20</span></span><span className="flex gap-2"><Button variant="danger" size="sm">拒绝</Button><Button size="sm">批准</Button></span></ListGroupItem>
          <ListGroupItem className="text-xs text-text-secondary">没有更多申请。</ListGroupItem>
        </ListGroup>
      </div>
      <div className="space-y-2">
        <p className="text-xs text-text-secondary">Chip · 房间 Agent 能力 / 可移除的按人规则</p>
        <ul className="flex flex-wrap gap-2" aria-label="房间里的 Agent"><Chip as="li" align="start" icon={<Bot />}><span className="truncate">Atlas</span><Badge tone="success">可咨询</Badge></Chip><Chip as="li" align="start" icon={<Bot />}><span className="truncate">Coder</span><Badge>只读</Badge></Chip></ul>
        <ul className="flex flex-wrap gap-1.5" aria-label="按人设置的规则">{rules.map((rule) => <Chip as="li" key={rule} removeLabel={`删除 ${rule}`} onRemove={() => setRules((all) => all.filter((r) => r !== rule))}><span className="truncate">{rule}</span></Chip>)}</ul>
      </div>
    </div>
  </section>;
}
