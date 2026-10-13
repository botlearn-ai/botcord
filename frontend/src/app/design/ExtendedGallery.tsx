"use client";
/**
 * [INPUT]: Shared form, content, data and marketing primitives
 * [OUTPUT]: Interactive examples of audited component types missing from the initial gallery
 * [POS]: /design coverage extension; uses fixtures without backend access
 * [PROTOCOL]: Add new primitive examples here and update COMPONENTS.md
 */
import { useState } from "react";
import { Settings, Trash2 } from "lucide-react";
import { useConfirm } from "@/store/useConfirmStore";
import Alert from "@/components/ui/Alert";
import AttachmentItem from "@/components/ui/AttachmentItem";
import Button from "@/components/ui/Button";
import CopyableId from "@/components/ui/CopyableId";
import CordField from "@/components/ui/CordField";
import Disclosure from "@/components/ui/Disclosure";
import DialogSurface from "@/components/ui/DialogSurface";
import DismissLayer from "@/components/ui/DismissLayer";
import SwipeableRow from "@/components/ui/SwipeableRow";
import { toast } from "@/components/ui/Toast";
import LinkButton from "@/components/ui/LinkButton";
import DrawerShell from "@/components/ui/DrawerShell";
import Field from "@/components/ui/Field";
import IconButton from "@/components/ui/IconButton";
import ImagePreviewOverlay from "@/components/ui/ImagePreviewOverlay";
import MarkdownContent from "@/components/ui/MarkdownContent";
import MarketingButton from "@/components/ui/MarketingButton";
import MarketingCard from "@/components/ui/MarketingCard";
import MetricCard from "@/components/ui/MetricCard";
import MultiSelect from "@/components/ui/MultiSelect";
import Radio from "@/components/ui/Radio";
import SearchInput from "@/components/ui/SearchInput";
import SectionHeading from "@/components/ui/SectionHeading";
import Select from "@/components/ui/Select";
import SingleSelect from "@/components/ui/SingleSelect";
import SystemMessageNotice from "@/components/ui/SystemMessageNotice";
import Table, { TableHead, TableBody, TableRow, TableHeader, TableCell } from "@/components/ui/Table";
import TypewriterCode from "@/components/ui/TypewriterCode";
import UnreadBadge from "@/components/ui/UnreadBadge";

const OPTIONS = [{ value: "atlas", label: "Atlas", sublabel: "Research agent" }, { value: "coder", label: "Coder", sublabel: "Development agent" }, { value: "offline", label: "Offline agent", disabled: true }];
export default function ExtendedGallery() {
  const [selected, setSelected] = useState<string | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [surfaceOpen, setSurfaceOpen] = useState(false);
  const [dismissVisible, setDismissVisible] = useState(false);
  const [swipeOpen, setSwipeOpen] = useState(false);
  const confirm = useConfirm();
  return <div className="space-y-10 border-t border-border py-10">
    <section id="selection" className="space-y-5">
      <h2 className="type-heading-2">选择与搜索</h2>
      <p className="text-sm text-text-secondary">原生单选、带说明的单选、可搜索多选和搜索框。原有 dashboard 入口已复用这里的组件。</p>
      <div className="grid gap-6 md:grid-cols-2">
        <Field label="Select · 原生选择"><Select defaultValue="all"><option value="all">全部 Agent</option><option value="online">在线</option><option disabled>不可用</option></Select></Field>
        <Field label="Select · 禁用"><Select disabled><option>暂无可选项</option></Select></Field>
        <div className="space-y-2"><p className="text-xs text-text-secondary">SingleSelect · 单选</p><SingleSelect value={selected} onChange={setSelected} options={OPTIONS} placeholder="选择 Agent" /></div>
        <div className="space-y-2"><p className="text-xs text-text-secondary">MultiSelect · 多选</p><MultiSelect value={members} onChange={setMembers} options={OPTIONS.slice(0, 2)} placeholder="选择成员" searchPlaceholder="搜索成员" emptyLabel="无匹配成员" selectedLabel={(n) => `已选 ${n}`} /></div>
        <SearchInput label="搜索组件示例" placeholder="输入搜索词" value={query} onChange={(e) => setQuery(e.target.value)} />
        <fieldset className="flex flex-wrap items-center gap-4"><legend className="mb-2 text-xs text-text-secondary">Radio · 回复方式</legend><label className="inline-flex items-center gap-2 text-sm"><Radio name="gallery-reply" value="always" defaultChecked />总是回复</label><label className="inline-flex items-center gap-2 text-sm"><Radio name="gallery-reply" value="mention" />仅提及</label><label className="inline-flex items-center gap-2 text-sm"><Radio name="gallery-reply" disabled />禁用</label></fieldset>
      </div>
    </section>
    <section id="persistent-feedback" className="space-y-4">
      <h2 className="type-heading-2">行内反馈与抽屉</h2>
      <div className="grid gap-3 md:grid-cols-2"><Alert title="正在同步">连接建立后会更新列表。</Alert><Alert tone="success" title="已保存">回复规则已更新。</Alert><Alert tone="warning" title="需要授权">转账尚未执行。</Alert><Alert tone="danger" title="保存失败" actions={<Button size="sm">重试</Button>}>请检查连接后重试。</Alert></div>
      <div className="flex flex-wrap items-center gap-3"><IconButton label="设置"><Settings /></IconButton><IconButton label="删除" danger><Trash2 /></IconButton><IconButton label="不可用" disabled><Settings /></IconButton><Button onClick={() => setDrawer(true)}>打开抽屉</Button><Button onClick={() => void confirm({ title: "确认更新规则？", message: "此示例不会修改任何数据。", confirmLabel: "确认", cancelLabel: "取消" })}>打开确认框</Button></div>
      <Disclosure title="Disclosure · 查看详细信息"><p>折叠区使用原生 details，支持键盘操作。</p></Disclosure>
    </section>
    <section id="data" className="space-y-4">
      <h2 className="type-heading-2">数据展示</h2>
      <div className="grid gap-3 sm:grid-cols-3"><MetricCard label="在线 Agent" value={8} /><MetricCard label="待处理申请" value={3} accent /><MetricCard label="本月用量" value="1,284" detail="统计范围：当前团队" /></div>
      <div className="overflow-x-auto rounded-xl border border-border"><Table><caption className="p-3 text-left text-sm text-text-secondary">Agent 列表 · 示例数据</caption><TableHead><TableRow><TableHeader>名称</TableHeader><TableHeader>角色</TableHeader><TableHeader>未读</TableHeader></TableRow></TableHead><TableBody><TableRow><TableCell>Atlas</TableCell><TableCell>Research</TableCell><TableCell><UnreadBadge count={4} label="4 条未读消息" /></TableCell></TableRow><TableRow><TableCell>Coder</TableCell><TableCell>Development</TableCell><TableCell><UnreadBadge count={120} /></TableCell></TableRow></TableBody></Table></div>
      <CopyableId value="ag_gallery_example" />
    </section>
    <section id="content" className="space-y-4">
      <h2 className="type-heading-2">消息内容与附件</h2>
      <div className="rounded-xl border border-border bg-surface p-4"><MarkdownContent content={'**Atlas** 已完成整理。\n\n- 支持 Markdown 列表\n- 代码、链接和表格沿用消息文档样式\n\n```json\n{"status":"done"}\n```'} /></div>
      <SystemMessageNotice text="Atlas 加入了房间" timestamp="10:24" />
      <AttachmentItem attachment={{ filename: "BotCord Logo.svg", url: "favicon.svg", content_type: "image/svg+xml", size_bytes: 640 }} onPreview={() => setImageOpen(true)} />
      <Button onClick={() => setImageOpen(true)}>打开图片预览</Button>
    </section>
    <section id="composition" className="space-y-4">
      <h2 className="type-heading-2">组合控件与导航</h2>
      <div className="flex flex-wrap items-center gap-3">
        <LinkButton href="/design/pilot">真实页面试点</LinkButton>
        <Button onClick={() => setSurfaceOpen(true)}>无内置动画弹层</Button>
        <Button onClick={() => setDismissVisible(true)}>局部关闭遮罩</Button>
      </div>
      <Button variant="row" aria-pressed><span className="block font-medium">已选列表行</span><span className="type-body-sm">多行内容使用 row，导航使用 LinkButton 保留链接行为。</span></Button>
      <div className="relative flex h-28 items-center justify-center rounded-xl border border-border">
        <span className="text-sm text-text-secondary">局部导航示例</span>
        {dismissVisible && <DismissLayer label="关闭局部遮罩" className="absolute inset-0 rounded-xl" onClick={() => setDismissVisible(false)} />}
      </div>
      <div className="max-w-sm rounded-xl border border-border bg-surface py-1">
        <SwipeableRow open={swipeOpen} onOpenChange={setSwipeOpen} label="会话操作：AI 每日情报" actions={[
          { label: "置顶", className: "bg-surface-sunken text-text-primary", onClick: () => toast({ title: "已置顶" }) },
          { label: "标为已读", className: "bg-accent text-on-accent", onClick: () => toast({ title: "已标为已读" }) },
        ]}>
          <div className="rounded-xl px-3 py-3 pr-12"><span className="block text-sm font-medium">AI 每日情报</span><span className="type-body-sm text-text-secondary">触屏左滑露出操作；桌面点右下角“更多”。</span></div>
        </SwipeableRow>
      </div>
    </section>
    <section id="marketing" className="space-y-4">
      <h2 className="type-heading-2">营销页与品牌</h2>
      <MarketingCard><SectionHeading title="让 Agent 连接起来" subtitle="营销页复用品牌辅助图形、区块标题和 CTA。" /><div className="flex flex-wrap justify-center gap-3"><MarketingButton href="#selection">查看组件</MarketingButton><MarketingButton variant="primary" onClick={() => setDrawer(true)}>体验交互</MarketingButton></div><div className="relative mt-6 h-32 overflow-hidden"><CordField className="absolute inset-0 h-full w-full" /></div></MarketingCard>
      <TypewriterCode code={'{ "from": "Atlas", "to": "Coder", "status": "delivered" }'} />
    </section>
    {surfaceOpen && <DialogSurface title="组合式弹层" onClose={() => setSurfaceOpen(false)}><div className="space-y-4 p-5"><h3 className="text-lg font-semibold">组合式弹层</h3><p className="text-sm text-text-secondary">共享焦点、Esc 和滚动锁，动画由业务组件持有。</p><Button onClick={() => setSurfaceOpen(false)}>关闭</Button></div></DialogSurface>}
    {drawer ? <DrawerShell title="Agent 详情" closeLabel="关闭抽屉" description="共享标题、正文和底部操作区" onClose={() => setDrawer(false)} footer={(close) => <Button onClick={close}>完成</Button>}><Alert tone="neutral">此抽屉仅展示组件，不连接业务数据。</Alert><Disclosure className="mt-4" title="运行信息">当前状态：在线</Disclosure></DrawerShell> : null}
    {imageOpen ? <ImagePreviewOverlay src="/favicon.svg?v=2" title="BotCord Logo" onClose={() => setImageOpen(false)} onImageError={() => setImageOpen(false)} /> : null}
  </div>;
}
