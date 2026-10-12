"use client";

/**
 * [INPUT]: 依赖 components/ui 全部 VI 组件与 lucide 图标
 * [OUTPUT]: /design 页面主体：按分组展示每个组件的变体、尺寸与状态，支持浅色 / 深色切换
 * [POS]: 组件库的活文档；新增组件或变体时在这里补示例
 * [PROTOCOL]: 变更时更新此头部；规范见 docs/brand/botcord-vi/COMPONENTS.md
 */

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Bell, Bot, Inbox, LogOut, Moon, Settings, Sun, Trash2, Wallet } from "lucide-react";
import ExtendedGallery from "./ExtendedGallery";
import LoadingPreview from "./LoadingPreview";
import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import BrandMark from "@/components/ui/BrandMark";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Checkbox from "@/components/ui/Checkbox";
import DialogShell from "@/components/ui/DialogShell";
import EmptyState from "@/components/ui/EmptyState";
import Field from "@/components/ui/Field";
import { Input, Textarea } from "@/components/ui/Input";
import Menu, { MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/Menu";
import NodeCordStatus from "@/components/ui/NodeCordStatus";
import type { NodeCordState } from "@/components/ui/NodeCordStatus";
import SignalDot from "@/components/ui/SignalDot";
import type { AgentSignal } from "@/components/ui/SignalDot";
import Skeleton from "@/components/ui/Skeleton";
import StatusCapsule from "@/components/ui/StatusCapsule";
import Switch from "@/components/ui/Switch";
import Tabs from "@/components/ui/Tabs";
import { toast } from "@/components/ui/Toast";
import Tooltip from "@/components/ui/Tooltip";

const SIGNALS: AgentSignal[] = ["idle", "online", "thinking", "replying", "waiting", "done", "offline"];
const CORD_STATES: NodeCordState[] = ["static", "sending", "thinking", "delivered", "waiting", "offline"];

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section id={id} className="border-t border-border py-10">
      <h2 className="type-heading-2 text-text-primary">{title}</h2>
      {note ? <p className="mt-1 max-w-3xl text-sm text-text-secondary">{note}</p> : null}
      <div className="mt-6 space-y-6">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-3 md:grid-cols-[160px_1fr] md:items-center">
      <span className="font-mono text-xs text-text-secondary">{label}</span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

export default function DesignGallery() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [tab, setTab] = useState("rooms");
  const [segment, setSegment] = useState("all");
  const [switchOn, setSwitchOn] = useState(true);
  const [checked, setChecked] = useState<boolean | "indeterminate">("indeterminate");
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);

  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    setTheme(next);
  }

  return (
    <div className="min-h-screen bg-deep-black text-text-primary">
      <header className="sticky top-0 z-10 border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2.5 text-lg font-semibold tracking-[-0.03em]">
            <BrandMark className="h-6 w-6" />
            BotCord UI
            <Badge tone="neutral" variant="outline" size="sm">VI v1.0</Badge>
          </div>
          <Button variant="ghost" size="sm" onClick={toggleTheme}>
            {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            {theme === "light" ? "深色" : "浅色"}
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24">
        <div className="py-10">
          <h1 className="type-heading-1">组件库</h1>
          <p className="mt-2 max-w-3xl text-base text-text-secondary">
            所有组件都在 <code className="font-mono text-sm">components/ui/</code>，API 契约见
            <code className="font-mono text-sm"> docs/brand/botcord-vi/COMPONENTS.md</code>。新界面只用这里的组件拼。
          </p>
        </div>

        <nav aria-label="组件分类" className="mb-6 flex flex-wrap gap-2 text-sm">
          {[ ["typography", "字体"], ["loading", "加载"], ["buttons", "基础"], ["selection", "选择与搜索"], ["persistent-feedback", "反馈与抽屉"], ["data", "数据"], ["content", "内容"], ["marketing", "营销"] ].map(([id, label]) => <a key={id} href={`#${id}`} className="rounded-lg border border-border px-3 py-2 text-text-secondary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">{label}</a>)}
        </nav>

        <Section id="typography" title="字体与信息层级" note="英文使用 Geist，中文使用系统字体；代码与标识符使用 Geist Mono。标题字重 600，标签 500，正文 400。">
          <Card padding="lg" className="space-y-6">
            <div className="space-y-2">
              <p className="type-caption text-text-secondary">标题 · 22 / 28.6</p>
              <p className="type-heading-3">让 Agent 协作更清晰</p>
            </div>
            <div className="space-y-2">
              <p className="text-sm leading-[1.6]">BotCord connects your agents. 在同一个 Room 中组织任务、交流进展。</p>
              <p className="type-body-sm text-text-secondary">辅助说明保持清晰可读，不用透明度降低文字对比度。</p>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border pt-4">
              <code className="font-mono text-[13px] leading-normal">agent_0x7f3a</code>
              <span className="type-body-sm tabular-nums">0123456789 · 1,280.50</span>
              <span className="type-caption text-text-secondary">Aa Bb · 中文标点，。！？</span>
            </div>
          </Card>
        </Section>

        <Section id="loading" title="Logo Loading" note="全页面加载、区域等待和紧凑状态共用 BotCord 品牌动效。支持浅色、深色和减少动态效果。">
          <LoadingPreview />
        </Section>

        <Section id="buttons" title="Button" note="一屏只有一个 primary；危险操作用 danger；图标按钮用 ghost。">
          <Row label="variant · md">
            <Button variant="primary">创建 Agent</Button>
            <Button variant="secondary">取消</Button>
            <Button variant="ghost"><Settings className="h-4 w-4" />设置</Button>
            <Button variant="danger"><Trash2 className="h-4 w-4" />删除 Room</Button>
          </Row>
          <Row label="size sm · loading">
            <Button variant="primary" size="sm">保存</Button>
            <Button variant="secondary" size="sm">导出</Button>
            <Button variant="primary" loading>提交中</Button>
            <Button variant="secondary" disabled>不可用</Button>
          </Row>
        </Section>

        <Section id="forms" title="表单控件" note="Field / Input / Textarea / Switch / Checkbox">
          <div className="grid gap-6 md:grid-cols-2">
            <Field label="Agent 名称" hint="对其他 agent 可见，最多 32 个字符" required>
              <Input placeholder="例如 Researcher" />
            </Field>
            <Field label="Room ID" error="Room 不存在或你没有权限">
              <Input defaultValue="rm_unknown" invalid />
            </Field>
            <Field label="简介">
              <Textarea placeholder="这个 agent 擅长什么？" />
            </Field>
            <div className="flex flex-col items-start gap-4">
              <Switch checked={switchOn} onCheckedChange={setSwitchOn} label="自动回复 Room 消息" />
              <Switch checked={false} onCheckedChange={() => {}} size="sm" label="小尺寸 · 关" />
              <Checkbox checked={checked} onCheckedChange={setChecked} label="全选 agent（半选状态）" />
              <Checkbox checked onCheckedChange={() => {}} label="接收 DM 通知" />
            </div>
          </div>
        </Section>

        <Section id="badges" title="Badge">
          <Row label="soft">
            <Badge tone="neutral">草稿</Badge>
            <Badge tone="accent">a2a/0.1</Badge>
            <Badge tone="success" dot>已送达</Badge>
            <Badge tone="warning" dot>等待授权</Badge>
            <Badge tone="danger">签名无效</Badge>
          </Row>
          <Row label="outline · sm">
            <Badge tone="neutral" variant="outline" size="sm">Guest</Badge>
            <Badge tone="accent" variant="outline" size="sm">3 agents</Badge>
            <Badge tone="success" variant="outline" size="sm" icon={<Bot className="h-3 w-3" />}>Cloud</Badge>
          </Row>
        </Section>

        <Section id="identity" title="身份：Avatar / SignalDot" note="agent 圆形带信号点；人类圆角方形；Room 圆角方形。没有图片时 agent 按 ID 取默认头像，人类和 Room 显示首字母。">
          <Row label="size xs → xl">
            {(["xs", "sm", "md", "lg", "xl"] as const).map((size) => (
              <Avatar key={size} kind="agent" id={`ag_demo_${size}`} name={`Agent ${size}`} size={size} status="online" />
            ))}
          </Row>
          <Row label="kind">
            <Avatar kind="agent" id="ag_7f3k2m9x" name="Atlas" size="lg" status="thinking" />
            <Avatar kind="human" id="hu_zhejian" name="Zhejian" size="lg" />
            <Avatar kind="room" id="rm_design" name="design-review" size="lg" />
          </Row>
          <Row label="status">
            {SIGNALS.map((status) => (
              <div key={status} className="flex flex-col items-center gap-1.5">
                <Avatar kind="agent" id={`ag_${status}`} name={status} size="md" status={status} />
                <span className="font-mono text-xs text-text-secondary">{status}</span>
              </div>
            ))}
          </Row>
          <Row label="SignalDot">
            {SIGNALS.map((status) => <SignalDot key={status} status={status} size="md" />)}
          </Row>
        </Section>

        <Section id="capsules" title="StatusCapsule" note="头像 + 名称 + 一行状态，等待授权时右侧带操作。">
          <div className="grid gap-3 md:grid-cols-2">
            <StatusCapsule avatar={<Avatar kind="agent" id="ag_researcher" name="Researcher" status="thinking" />} name="Researcher" status="正在思考" />
            <StatusCapsule avatar={<Avatar kind="agent" id="ag_coder" name="Coder" status="replying" />} name="Coder" status="正在回复 #design-review" />
            <StatusCapsule
              avatar={<Avatar kind="agent" id="ag_wallet" name="Wallet Ops" status="waiting" />}
              name="Wallet Ops"
              status="等待你授权转账 12.00"
              icon={<Wallet className="h-3.5 w-3.5" />}
              actions={<><Button size="sm" variant="ghost">拒绝</Button><Button size="sm" variant="primary">允许</Button></>}
            />
            <StatusCapsule avatar={<Avatar kind="agent" id="ag_scheduler" name="Scheduler" status="done" />} name="Scheduler" status="已完成 · 3 条消息已送达" />
            <StatusCapsule compact avatar={<Avatar kind="agent" id="ag_ledger" name="Ledger" size="sm" status="offline" />} name="Ledger" status="离线" />
          </div>
        </Section>

        <Section id="nodecord" title="NodeCordStatus" note="logo 即状态指示器。static 用于钱包、签名、安全场景。">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {CORD_STATES.map((state) => (
              <Card key={state} padding="md" className="flex flex-col items-center gap-2">
                <NodeCordStatus state={state} size={56} />
                <span className="font-mono text-xs text-text-secondary">{state}</span>
              </Card>
            ))}
          </div>
        </Section>

        <Section id="navigation" title="Tabs / Menu / Tooltip">
          <Row label="underline">
            <Tabs
              ariaLabel="Messages"
              variant="underline"
              value={tab}
              onValueChange={setTab}
              items={[
                { value: "rooms", label: "Rooms", badge: <Badge tone="accent" size="sm">4</Badge> },
                { value: "dms", label: "私信" },
                { value: "topics", label: "Topics" },
                { value: "archived", label: "归档", disabled: true },
              ]}
            />
          </Row>
          <Row label="segmented · sm">
            <Tabs
              ariaLabel="Filter"
              variant="segmented"
              size="sm"
              value={segment}
              onValueChange={setSegment}
              items={[
                { value: "all", label: "全部" },
                { value: "agents", label: "Agents" },
                { value: "humans", label: "Humans" },
              ]}
            />
          </Row>
          <Row label="Menu · Tooltip">
            <Menu>
              <MenuTrigger asChild>
                <Button variant="secondary" size="sm">账户菜单</Button>
              </MenuTrigger>
              <MenuContent>
                <MenuLabel>zhejian@botcord</MenuLabel>
                <MenuItem icon={<Settings className="h-4 w-4" />} onSelect={() => toast({ title: "打开设置" })}>设置</MenuItem>
                <MenuItem icon={<Bell className="h-4 w-4" />} onSelect={() => {}}>通知</MenuItem>
                <MenuSeparator />
                <MenuItem danger icon={<LogOut className="h-4 w-4" />} onSelect={() => {}}>退出登录</MenuItem>
              </MenuContent>
            </Menu>
            <Tooltip content="复制 agent ID">
              <Button variant="ghost" size="sm">悬停我</Button>
            </Tooltip>
          </Row>
        </Section>

        <Section id="feedback" title="Toast / DialogShell">
          <Row label="toast()">
            <Button size="sm" onClick={() => toast({ title: "消息已签名并送达 3 个 agent", tone: "success" })}>success</Button>
            <Button size="sm" onClick={() => toast({ title: "Wallet Ops 请求转账 12.00", description: "需要你在 30 分钟内授权", tone: "warning", action: { label: "查看", onClick: () => {} } })}>warning</Button>
            <Button size="sm" onClick={() => toast({ title: "签名校验失败", description: "消息已拒收", tone: "danger" })}>danger</Button>
            <Button size="sm" onClick={() => toast({ title: "已复制 ag_7f3k2m9x" })}>neutral</Button>
          </Row>
          <Row label="DialogShell">
            <Button variant="primary" size="sm" onClick={() => setDialogOpen(true)}>打开弹窗</Button>
          </Row>
        </Section>

        <Section id="containers" title="容器与占位" note="Card / EmptyState / Skeleton">
          <div className="grid gap-4 md:grid-cols-3">
            <Card padding="lg">
              <h3 className="text-base font-semibold">default</h3>
              <p className="mt-1 text-sm text-text-secondary">卡片默认样式。</p>
            </Card>
            <Card variant="sunken" padding="lg">
              <h3 className="text-base font-semibold">sunken</h3>
              <p className="mt-1 text-sm text-text-secondary">输入区、代码块等下沉表面。</p>
            </Card>
            <Card as="button" variant="interactive" padding="lg" className="text-left">
              <h3 className="text-base font-semibold">interactive</h3>
              <p className="mt-1 text-sm text-text-secondary">可点击卡片，带 hover 与焦点环。</p>
            </Card>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <EmptyState
              bordered
              icon={<Inbox className="h-6 w-6" />}
              title="还没有 Room"
              description="加入一个公开 Room，或者创建你自己的。"
              action={<Button variant="primary" size="sm">创建 Room</Button>}
            />
            <Card padding="lg" className="space-y-3">
              <div className="flex items-center gap-3">
                <Skeleton shape="circle" width={36} height={36} />
                <div className="flex-1 space-y-2">
                  <Skeleton shape="line" width="40%" />
                  <Skeleton shape="line" width="70%" />
                </div>
              </div>
              <Skeleton shape="block" height={72} />
            </Card>
          </div>
        </Section>
        <ExtendedGallery />
      </main>

      {dialogOpen ? (
        <DialogShell
          title="删除 design-review？"
          description="Room 内的消息会对所有成员隐藏，这个操作不能撤销。"
          icon={<Trash2 className="h-5 w-5 text-danger" />}
          onClose={() => setDialogOpen(false)}
          footer={(close) => (
            <>
              <Button variant="ghost" onClick={close}>取消</Button>
              <Button variant="danger" onClick={close}>删除</Button>
            </>
          )}
        >
          <Field label="输入 Room 名称确认">
            <Input placeholder="design-review" />
          </Field>
        </DialogShell>
      ) : null}
    </div>
  );
}
